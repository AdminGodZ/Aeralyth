\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:026-realtime-changes', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '026-realtime-changes'
) AS apply_migration \gset
\if :apply_migration

-- Writers only append transaction-local invalidations. They never acquire a
-- shared cursor lock, including when two accounts modify reciprocal shares.
CREATE TABLE realtime_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('files', 'shared', 'repositories', 'profile', 'vault', 'security', 'users')),
  folder_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (transaction_id, user_id, scope),
  CHECK (cardinality(folder_ids) <= 32)
);

-- Delivery IDs are allocated only by the serialized dispatcher, after the
-- writer commits. An earlier, slower transaction cannot fall behind a cursor.
CREATE TABLE realtime_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  folder_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX realtime_events_user_cursor_idx ON realtime_events (user_id, id);
CREATE INDEX realtime_events_created_idx ON realtime_events (created_at, id);
CREATE TABLE realtime_stream_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  head BIGINT NOT NULL DEFAULT 0,
  floor BIGINT NOT NULL DEFAULT 0
);
INSERT INTO realtime_stream_state (singleton) VALUES (TRUE);

-- Empty means the entire scope; an empty string inside the array is the root
-- folder. Large tree mutations deliberately collapse to a scope invalidation.
CREATE FUNCTION realtime_merge_folders(a TEXT[], b TEXT[]) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN cardinality(a) = 0 OR cardinality(b) = 0 OR count(*) > 32
    THEN '{}'::text[] ELSE COALESCE(array_agg(folder ORDER BY folder), '{}'::text[]) END
  FROM (SELECT DISTINCT unnest(a || b) AS folder LIMIT 33) AS folders
$$;

CREATE FUNCTION realtime_enqueue(target_user TEXT, target_scope TEXT, folders TEXT[] DEFAULT '{}')
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF target_user IS NULL THEN RETURN; END IF;
  INSERT INTO realtime_outbox (user_id, scope, folder_ids)
  VALUES (target_user, target_scope,
    CASE WHEN cardinality(folders) > 32 THEN '{}'::text[] ELSE folders END)
  ON CONFLICT (transaction_id, user_id, scope) DO UPDATE
    SET folder_ids = realtime_merge_folders(realtime_outbox.folder_ids, EXCLUDED.folder_ids);
  PERFORM pg_notify('aeralyth_changes', 'pending');
END;
$$;

-- Statement transition tables keep a bulk operation proportional to changed
-- rows, rather than appending one event per file. Only IDs enter the outbox.
CREATE FUNCTION realtime_files_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_sql TEXT; target RECORD;
BEGIN
  IF TG_TABLE_NAME = 'vault_node_heads' THEN
    IF TG_OP = 'DELETE' THEN
      source_sql := 'SELECT node_id AS id, owner_id FROM realtime_old';
    ELSIF TG_OP = 'INSERT' THEN
      source_sql := 'SELECT node_id AS id, owner_id FROM realtime_new';
    ELSE
      source_sql := 'SELECT n.node_id AS id, n.owner_id FROM realtime_new n JOIN realtime_old o USING (node_id)
        WHERE (n.record_version, n.record_hash) IS DISTINCT FROM (o.record_version, o.record_hash)';
    END IF;
    source_sql := format('SELECT n.id, n.owner_id, f.parent_id FROM (%s) n LEFT JOIN files f ON f.id = n.id', source_sql);
  ELSIF TG_OP = 'DELETE' THEN
    source_sql := 'SELECT id, owner_id, parent_id FROM realtime_old';
  ELSIF TG_OP = 'INSERT' THEN
    source_sql := 'SELECT id, owner_id, parent_id FROM realtime_new WHERE e2ee_state <> ''staged''';
  ELSE
    source_sql := 'SELECT n.id, n.owner_id, n.parent_id FROM realtime_new n JOIN realtime_old o USING (id)
      WHERE (n.original_name, n.parent_id, n.state, n.favorite, n.size_bytes, n.updated_at, n.e2ee_state,
             n.current_generation_id, n.legacy_share_count, n.vault_share_count)
        IS DISTINCT FROM
            (o.original_name, o.parent_id, o.state, o.favorite, o.size_bytes, o.updated_at, o.e2ee_state,
             o.current_generation_id, o.legacy_share_count, o.vault_share_count)
        AND (n.e2ee_state <> ''staged'' OR o.e2ee_state <> ''staged'')
      UNION SELECT o.id, o.owner_id, o.parent_id FROM realtime_old o JOIN realtime_new n USING (id)
        WHERE (o.parent_id, o.owner_id) IS DISTINCT FROM (n.parent_id, n.owner_id)';
  END IF;

  FOR target IN EXECUTE format($query$
    WITH RECURSIVE changed AS MATERIALIZED (%s),
    ancestors AS (
      SELECT id, owner_id, parent_id FROM changed
      UNION
      SELECT p.id, p.owner_id, p.parent_id FROM files p
      JOIN ancestors a ON p.id = a.parent_id AND p.owner_id = a.owner_id
    ), audience AS (
      SELECT owner_id AS user_id, 'files'::text AS scope,
        CASE WHEN count(*) > 16 THEN '{}'::text[]
          ELSE array_agg(DISTINCT COALESCE(parent_id, '')) || array_agg(DISTINCT id) END AS folders
      FROM changed GROUP BY owner_id
      UNION ALL
      SELECT DISTINCT s.recipient_id, 'shared', '{}'::text[]
      FROM ancestors a JOIN file_shares s ON s.file_id = a.id AND s.owner_id = a.owner_id
      UNION ALL
      SELECT DISTINCT r.recipient_id, 'shared', '{}'::text[]
      FROM ancestors a JOIN vault_shares s ON s.root_node_id = a.id AND s.owner_id = a.owner_id
      JOIN vault_share_recipients r ON r.share_id = s.id
      WHERE s.status IN ('active', 'rotating') AND r.status = 'active'
      UNION ALL
      SELECT DISTINCT s.recipient_id, 'shared', '{}'::text[]
      FROM ancestors a JOIN share_links s ON s.root_file_id = a.id AND s.owner_id = a.owner_id
      WHERE s.recipient_id IS NOT NULL AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
    ) SELECT * FROM audience
  $query$, source_sql) LOOP
    PERFORM realtime_enqueue(target.user_id, target.scope, target.folders);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Old recipients receive a generic shared-view invalidation on revocation.
-- No file IDs or share tokens are disclosed to those recipients.
CREATE FUNCTION realtime_related_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_sql TEXT; row_sql TEXT; target RECORD; own_scope TEXT;
BEGIN
  source_sql := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT * FROM realtime_new'
    WHEN 'DELETE' THEN 'SELECT * FROM realtime_old'
    ELSE 'SELECT * FROM realtime_new UNION ALL SELECT * FROM realtime_old' END;
  own_scope := CASE TG_TABLE_NAME
    WHEN 'repositories' THEN 'repositories'
    WHEN 'users' THEN 'profile'
    WHEN 'sessions' THEN 'security'
    WHEN 'user_vaults' THEN 'vault'
    ELSE 'files' END;
  IF TG_TABLE_NAME = 'users' THEN
    row_sql := format('SELECT DISTINCT id AS user_id, %L AS scope FROM (%s) r
      UNION SELECT id, ''users'' FROM users WHERE role = ''admin'' AND status = ''active''
        AND EXISTS (SELECT 1 FROM (%s) changed)', own_scope, source_sql, source_sql);
  ELSIF TG_TABLE_NAME IN ('sessions', 'user_vaults') THEN
    row_sql := format('SELECT DISTINCT user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  ELSIF TG_TABLE_NAME IN ('file_shares', 'share_links') THEN
    row_sql := format('SELECT DISTINCT owner_id AS user_id, ''files'' AS scope FROM (%s) r
      UNION SELECT recipient_id, ''shared'' FROM (%s) r WHERE recipient_id IS NOT NULL', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_share_recipients' THEN
    row_sql := format('SELECT DISTINCT r.recipient_id AS user_id, ''shared'' AS scope FROM (%s) r
      UNION SELECT s.owner_id, ''files'' FROM (%s) r JOIN vault_shares s ON s.id = r.share_id', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_shares' THEN
    row_sql := format('SELECT DISTINCT owner_id AS user_id, ''files'' AS scope FROM (%s) r
      UNION SELECT recipient_id, ''shared'' FROM vault_share_recipients recipients
      JOIN (%s) r ON recipients.share_id = r.id', source_sql, source_sql);
  ELSE
    row_sql := format('SELECT DISTINCT owner_id AS user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  END IF;
  FOR target IN EXECUTE row_sql LOOP
    PERFORM realtime_enqueue(target.user_id, target.scope);
  END LOOP;
  RETURN NULL;
END;
$$;

DO $$
DECLARE relation TEXT; handler TEXT;
BEGIN
  FOREACH relation IN ARRAY ARRAY['files', 'vault_node_heads', 'repositories', 'file_shares',
    'share_links', 'vault_shares', 'vault_share_recipients', 'users', 'user_vaults', 'sessions'] LOOP
    handler := CASE WHEN relation IN ('files', 'vault_node_heads')
      THEN 'realtime_files_changed' ELSE 'realtime_related_changed' END;
    EXECUTE format('CREATE TRIGGER realtime_insert AFTER INSERT ON %I
      REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION %I()', relation, handler);
    EXECUTE format('CREATE TRIGGER realtime_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new
      FOR EACH STATEMENT EXECUTE FUNCTION %I()', relation, handler);
    EXECUTE format('CREATE TRIGGER realtime_delete AFTER DELETE ON %I
      REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION %I()', relation, handler);
  END LOOP;
END;
$$;

CREATE FUNCTION realtime_dispatch() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE dispatched INTEGER; new_head BIGINT; published_users TEXT[]; target_user TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:realtime-dispatch', 0)) THEN RETURN 0; END IF;
  WITH pending AS (
    DELETE FROM realtime_outbox WHERE id IN (SELECT id FROM realtime_outbox ORDER BY id LIMIT 512)
    RETURNING user_id, scope, folder_ids
  ), published AS (
    INSERT INTO realtime_events (user_id, scope, folder_ids)
    SELECT user_id, scope, folder_ids FROM pending RETURNING id, user_id
  ) SELECT count(*)::integer, max(id), array_agg(DISTINCT user_id)
    INTO dispatched, new_head, published_users FROM published;
  IF dispatched > 0 THEN
    UPDATE realtime_stream_state SET head = new_head WHERE singleton;
    FOREACH target_user IN ARRAY published_users LOOP
      PERFORM pg_notify('aeralyth_changes', 'user:' || target_user);
    END LOOP;
  END IF;
  RETURN dispatched;
END;
$$;

CREATE FUNCTION realtime_prune() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER; new_floor BIGINT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:realtime-dispatch', 0)) THEN RETURN 0; END IF;
  WITH expired AS (
    DELETE FROM realtime_events WHERE id IN (
      SELECT id FROM realtime_events
      WHERE created_at < now() - interval '24 hours'
        OR id <= (SELECT head - 100000 FROM realtime_stream_state WHERE singleton)
      ORDER BY id LIMIT 2048
    ) RETURNING id
  ) SELECT count(*)::integer, max(id) INTO removed, new_floor FROM expired;
  IF removed > 0 THEN
    UPDATE realtime_stream_state SET floor = GREATEST(floor, new_floor) WHERE singleton;
  END IF;
  RETURN removed;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('026-realtime-changes');
\else
\echo 'Skipping already-applied migration 026-realtime-changes'
\endif
COMMIT;
