\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:031-realtime-background-audiences', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '031-realtime-background-audiences'
) AS apply_migration \gset
\if :apply_migration

-- Parent listing changes and folder identity changes have different consumers.
-- A sibling's listing update must not invalidate an unchanged breadcrumb.
ALTER TABLE realtime_outbox DROP CONSTRAINT realtime_outbox_scope_check;
ALTER TABLE realtime_outbox ADD CONSTRAINT realtime_outbox_scope_check CHECK (
  scope IN ('files', 'paths', 'shared', 'repositories', 'profile', 'vault', 'security', 'users')
);

-- Foreground writes save identifiers only. Retain completed nodes until their
-- writer transaction has no work left: sibling changes and head/file triggers
-- then visit each ancestor just once, even across dispatcher transactions.
CREATE TABLE realtime_audience_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  kind TEXT NOT NULL CHECK (kind IN ('node', 'owner', 'vault-active', 'vault-all', 'admins')),
  owner_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  phase SMALLINT NOT NULL DEFAULT 0,
  after_id TEXT NOT NULL DEFAULT '',
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, kind, owner_id, entity_id)
);
CREATE INDEX realtime_audience_jobs_pending_idx ON realtime_audience_jobs (id) WHERE NOT complete;
CREATE INDEX realtime_audience_jobs_transaction_pending_idx
  ON realtime_audience_jobs (transaction_id) WHERE NOT complete;
CREATE INDEX realtime_audience_jobs_complete_idx ON realtime_audience_jobs (id) WHERE complete;
-- An outbox row disappears after publication. Keep a separate receipt while
-- its writer still has expansion jobs, so a recipient shared at several
-- ancestors gets one generic invalidation across all dispatcher pages.
CREATE TABLE realtime_audience_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id XID8 NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  UNIQUE (transaction_id, user_id, scope)
);
-- Each dispatcher page seeks within one owner or node, with no recipient sort
-- or entire-owner materialization before LIMIT.
CREATE INDEX file_shares_realtime_owner_idx ON file_shares (owner_id, id) INCLUDE (recipient_id);
CREATE INDEX file_shares_realtime_node_idx ON file_shares (owner_id, file_id, id) INCLUDE (recipient_id);
CREATE INDEX vault_shares_realtime_owner_idx ON vault_shares (owner_id, id) WHERE status IN ('active', 'rotating');
CREATE INDEX vault_shares_realtime_node_idx ON vault_shares (owner_id, root_node_id, id) WHERE status IN ('active', 'rotating');
CREATE INDEX share_links_realtime_owner_idx ON share_links (owner_id, id)
  INCLUDE (recipient_id, expires_at) WHERE recipient_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX share_links_realtime_node_idx ON share_links (owner_id, root_file_id, id)
  INCLUDE (recipient_id, expires_at) WHERE recipient_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX users_realtime_admin_idx ON users (id) WHERE role = 'admin' AND status = 'active';

CREATE OR REPLACE FUNCTION realtime_files_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_sql TEXT;
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
    source_sql := format('SELECT n.id, n.owner_id, f.parent_id, FALSE AS topology,
      COALESCE(f.entry_type = ''folder'', FALSE) AS path_change FROM (%s) n LEFT JOIN files f ON f.id = n.id', source_sql);
  ELSIF TG_OP = 'DELETE' THEN
    source_sql := 'SELECT id, owner_id, parent_id, TRUE AS topology, entry_type = ''folder'' AS path_change FROM realtime_old';
  ELSIF TG_OP = 'INSERT' THEN
    source_sql := 'SELECT id, owner_id, parent_id, FALSE AS topology, FALSE AS path_change FROM realtime_new WHERE e2ee_state <> ''staged''';
  ELSE
    source_sql := 'SELECT n.id, n.owner_id, n.parent_id,
        (n.parent_id, n.owner_id) IS DISTINCT FROM (o.parent_id, o.owner_id) AS topology,
        (n.entry_type = ''folder'' OR o.entry_type = ''folder'') AND
          (n.original_name, n.parent_id, n.owner_id, n.state, n.entry_type, n.e2ee_state) IS DISTINCT FROM
          (o.original_name, o.parent_id, o.owner_id, o.state, o.entry_type, o.e2ee_state) AS path_change
      FROM realtime_new n JOIN realtime_old o USING (id)
      WHERE (n.original_name, n.parent_id, n.owner_id, n.state, n.entry_type, n.favorite, n.size_bytes, n.updated_at, n.e2ee_state,
             n.current_generation_id, n.legacy_share_count, n.vault_share_count)
        IS DISTINCT FROM
            (o.original_name, o.parent_id, o.owner_id, o.state, o.entry_type, o.favorite, o.size_bytes, o.updated_at, o.e2ee_state,
             o.current_generation_id, o.legacy_share_count, o.vault_share_count)
        AND (n.e2ee_state <> ''staged'' OR o.e2ee_state <> ''staged'')
      UNION SELECT o.id, o.owner_id, o.parent_id, TRUE, o.entry_type = ''folder'' FROM realtime_old o JOIN realtime_new n USING (id)
        WHERE (o.parent_id, o.owner_id) IS DISTINCT FROM (n.parent_id, n.owner_id)
        AND (n.e2ee_state <> ''staged'' OR o.e2ee_state <> ''staged'')';
  END IF;

  EXECUTE format($query$
    WITH changed AS MATERIALIZED (%s), owners AS MATERIALIZED (
      SELECT owner_id, count(*) AS amount, bool_or(topology) AS topology FROM changed GROUP BY owner_id
    ), affected AS MATERIALIZED (
      SELECT DISTINCT owner_id, 'files'::text AS scope, COALESCE(parent_id, '') AS folder_id FROM changed
      UNION SELECT owner_id, 'paths', id FROM changed WHERE path_change
    ), scope_counts AS (
      SELECT owner_id, scope, count(*) AS amount FROM affected GROUP BY owner_id, scope
    ), enqueued AS (
      INSERT INTO realtime_outbox (user_id, scope, folder_ids)
      SELECT a.owner_id, a.scope, CASE WHEN c.amount > 32 THEN '{}'::text[] ELSE
        array_agg(a.folder_id ORDER BY a.folder_id) FILTER (WHERE c.amount <= 32) END
      FROM affected a JOIN scope_counts c USING (owner_id, scope)
      GROUP BY a.owner_id, a.scope, c.amount
      ON CONFLICT (transaction_id, user_id, scope) DO UPDATE
        SET folder_ids = realtime_merge_folders(realtime_outbox.folder_ids, EXCLUDED.folder_ids)
    )
    INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
    SELECT 'owner', owner_id, '' FROM owners WHERE topology OR amount > 32
    UNION SELECT 'node', c.owner_id, c.id FROM changed c JOIN owners o USING (owner_id)
      WHERE NOT o.topology AND o.amount <= 32
    UNION SELECT 'node', c.owner_id, c.parent_id FROM changed c JOIN owners o USING (owner_id)
      WHERE NOT o.topology AND o.amount <= 32 AND c.parent_id IS NOT NULL
    ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING
  $query$, source_sql);
  -- A move/delete may happen again before expansion. Its owner seed covers
  -- former paths without retaining private names or a historical tree. Direct
  -- grant deletions separately save their OLD recipients, including cascades.
  PERFORM pg_notify('aeralyth_changes', 'pending');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION realtime_related_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_sql TEXT; row_sql TEXT; own_scope TEXT;
BEGIN
  source_sql := CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM realtime_new'
    WHEN 'DELETE' THEN 'SELECT * FROM realtime_old'
    ELSE 'SELECT * FROM realtime_new UNION ALL SELECT * FROM realtime_old' END;
  own_scope := CASE TG_TABLE_NAME WHEN 'repositories' THEN 'repositories' WHEN 'users' THEN 'profile'
    WHEN 'sessions' THEN 'security' WHEN 'user_vaults' THEN 'vault' ELSE 'files' END;
  IF TG_TABLE_NAME = 'users' THEN
    row_sql := format('SELECT DISTINCT id AS user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
    EXECUTE format('INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
      SELECT ''admins'', '''', '''' WHERE EXISTS (SELECT 1 FROM (%s) r)
      ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING', source_sql);
  ELSIF TG_TABLE_NAME IN ('sessions', 'user_vaults') THEN
    row_sql := format('SELECT DISTINCT user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  ELSIF TG_TABLE_NAME IN ('file_shares', 'share_links') THEN
    row_sql := format('SELECT owner_id AS user_id, ''files'' AS scope FROM (%s) r
      UNION SELECT recipient_id, ''shared'' FROM (%s) r WHERE recipient_id IS NOT NULL', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_share_recipients' THEN
    row_sql := format('SELECT recipient_id AS user_id, ''shared'' AS scope FROM (%s) r
      UNION SELECT s.owner_id, ''files'' FROM (%s) r JOIN vault_shares s ON s.id = r.share_id', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_shares' THEN
    row_sql := format('SELECT DISTINCT owner_id AS user_id, ''files'' AS scope FROM (%s) r', source_sql);
    EXECUTE format('INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
      SELECT DISTINCT ''vault-all'', owner_id, id FROM (%s) r
      ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING', source_sql);
  ELSE
    row_sql := format('SELECT DISTINCT owner_id AS user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  END IF;
  EXECUTE format('INSERT INTO realtime_outbox (user_id, scope, folder_ids)
    SELECT DISTINCT user_id, scope, ''{}''::text[] FROM (%s) targets WHERE user_id IS NOT NULL
    ON CONFLICT (transaction_id, user_id, scope) DO UPDATE SET folder_ids = ''{}''::text[]', row_sql);
  PERFORM pg_notify('aeralyth_changes', 'pending');
  RETURN NULL;
END;
$$;

-- Called only while holding the dispatch advisory lock. Every iteration visits
-- one parent or at most 128 indexed grant rows. The loop bounds SQL, inserts,
-- and recipient memory independently of tree depth and share fanout.
CREATE FUNCTION realtime_expand_audiences() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE job realtime_audience_jobs%ROWTYPE; step INTEGER; scanned INTEGER; last_id TEXT;
  audience_sql TEXT; work INTEGER := 0;
BEGIN
  FOR step IN 1..8 LOOP
    SELECT * INTO job FROM realtime_audience_jobs WHERE NOT complete ORDER BY id LIMIT 1;
    EXIT WHEN NOT FOUND;
    work := work + 1;
    IF job.kind IN ('node', 'owner') AND job.phase = 0 THEN
      IF job.kind = 'node' THEN
        INSERT INTO realtime_audience_jobs (transaction_id, kind, owner_id, entity_id, created_at)
        SELECT job.transaction_id, 'node', job.owner_id, parent_id, job.created_at FROM files
        WHERE id = job.entity_id AND owner_id = job.owner_id AND parent_id IS NOT NULL
        ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING;
      END IF;
      UPDATE realtime_audience_jobs SET phase = 1 WHERE id = job.id;
      CONTINUE;
    END IF;
    IF job.kind IN ('node', 'owner') AND job.phase = 2 THEN
      -- Fanout to vault shares is also paged, before expanding their recipients.
      audience_sql := 'SELECT id FROM vault_shares WHERE owner_id = $1 AND id > $2
        AND status IN (''active'', ''rotating'')';
      IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND root_node_id = $3'; END IF;
      EXECUTE 'WITH page AS MATERIALIZED (' || audience_sql || ' ORDER BY id LIMIT 128), inserted AS (
        INSERT INTO realtime_audience_jobs (transaction_id, kind, owner_id, entity_id, created_at)
        SELECT $4, ''vault-active'', $1, id, $5 FROM page
        ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING
      ) SELECT count(*)::integer, max(id) FROM page'
      INTO scanned, last_id USING job.owner_id, job.after_id, job.entity_id, job.transaction_id, job.created_at;
    ELSE
      IF job.kind = 'admins' THEN
        audience_sql := 'SELECT id, id AS user_id, ''users''::text AS scope FROM users
          WHERE role = ''admin'' AND status = ''active'' AND id > $2';
      ELSIF job.kind IN ('vault-active', 'vault-all') THEN
        audience_sql := 'SELECT recipient_id AS id, recipient_id AS user_id, ''shared''::text AS scope, status
          FROM vault_share_recipients WHERE share_id = $3 AND recipient_id > $2';
      ELSIF job.phase = 1 THEN
        audience_sql := 'SELECT id, recipient_id AS user_id, ''shared''::text AS scope FROM file_shares
          WHERE owner_id = $1 AND id > $2';
        IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND file_id = $3'; END IF;
      ELSE
        audience_sql := 'SELECT id, recipient_id AS user_id, ''shared''::text AS scope FROM share_links
          WHERE owner_id = $1 AND id > $2 AND recipient_id IS NOT NULL AND revoked_at IS NULL';
        IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND root_file_id = $3'; END IF;
        -- Page expired grants too, so a large expired prefix cannot turn a
        -- nominal LIMIT into an unbounded scan. Check expiration at the writer
        -- timestamp, so expiration during queue lag cannot lose its audience.
        audience_sql := replace(audience_sql, 'FROM share_links', ', expires_at FROM share_links');
      END IF;
      EXECUTE 'WITH page AS MATERIALIZED (' || audience_sql || ' ORDER BY id LIMIT 128), fresh AS (
        INSERT INTO realtime_audience_deliveries (transaction_id, user_id, scope)
        SELECT DISTINCT $4, user_id, scope FROM page' ||
        CASE WHEN job.kind IN ('node', 'owner') AND job.phase = 3
          THEN ' WHERE expires_at IS NULL OR expires_at > $5'
          WHEN job.kind = 'vault-active' THEN ' WHERE status = ''active''
            AND EXISTS (SELECT 1 FROM vault_shares WHERE id = $3 AND status IN (''active'', ''rotating''))'
          ELSE '' END || '
        ON CONFLICT (transaction_id, user_id, scope) DO NOTHING RETURNING transaction_id, user_id, scope
      ), inserted AS (
        INSERT INTO realtime_outbox (transaction_id, user_id, scope, folder_ids)
        SELECT transaction_id, user_id, scope, ''{}''::text[] FROM fresh
        ON CONFLICT (transaction_id, user_id, scope) DO UPDATE SET folder_ids = ''{}''::text[]
      ) SELECT count(*)::integer, max(id) FROM page'
      INTO scanned, last_id USING job.owner_id, job.after_id, job.entity_id, job.transaction_id, job.created_at;
    END IF;
    IF scanned = 128 THEN
      UPDATE realtime_audience_jobs SET after_id = last_id WHERE id = job.id;
    ELSIF job.kind IN ('node', 'owner') AND job.phase < 3 THEN
      UPDATE realtime_audience_jobs SET phase = job.phase + 1, after_id = '' WHERE id = job.id;
    ELSE
      UPDATE realtime_audience_jobs SET complete = TRUE WHERE id = job.id;
    END IF;
  END LOOP;
  -- Bounded reclamation also leaves a completed-node dedup fence in place
  -- until all the work from its committed writer transaction has finished.
  DELETE FROM realtime_audience_jobs WHERE id IN (
    WITH candidates AS MATERIALIZED (
      SELECT id, transaction_id FROM realtime_audience_jobs WHERE complete ORDER BY id LIMIT 512
    ) SELECT done.id FROM candidates done WHERE NOT EXISTS (
      SELECT 1 FROM realtime_audience_jobs pending
      WHERE pending.transaction_id = done.transaction_id AND NOT pending.complete
    )
  );
  DELETE FROM realtime_audience_deliveries WHERE id IN (
    WITH candidates AS MATERIALIZED (
      SELECT id, transaction_id FROM realtime_audience_deliveries ORDER BY id LIMIT 512
    ) SELECT done.id FROM candidates done WHERE NOT EXISTS (
      SELECT 1 FROM realtime_audience_jobs pending WHERE pending.transaction_id = done.transaction_id AND NOT pending.complete
    ) AND NOT EXISTS (
      SELECT 1 FROM realtime_outbox pending WHERE pending.transaction_id = done.transaction_id
    )
  );
  RETURN work;
END;
$$;

CREATE OR REPLACE FUNCTION realtime_dispatch() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE dispatched INTEGER; new_head BIGINT; published_users TEXT[]; target_user TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:realtime-dispatch', 0)) THEN RETURN 0; END IF;
  PERFORM realtime_expand_audiences();
  WITH pending AS (
    DELETE FROM realtime_outbox WHERE id IN (SELECT id FROM realtime_outbox ORDER BY id LIMIT 512)
    RETURNING transaction_id, user_id, scope, folder_ids
  ), recorded AS (
    INSERT INTO realtime_audience_deliveries (transaction_id, user_id, scope)
    SELECT DISTINCT transaction_id, user_id, scope FROM pending
    WHERE scope IN ('shared', 'users') AND EXISTS (
      SELECT 1 FROM realtime_audience_jobs jobs
      WHERE jobs.transaction_id = pending.transaction_id AND NOT jobs.complete
    ) ON CONFLICT (transaction_id, user_id, scope) DO NOTHING
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
  -- The worker already treats 512 as more work. Retain that contract while
  -- allowing a page to make progress without publishing an event yet.
  IF EXISTS (SELECT 1 FROM realtime_audience_jobs) OR EXISTS (SELECT 1 FROM realtime_outbox)
    OR EXISTS (SELECT 1 FROM realtime_audience_deliveries)
    THEN RETURN 512; END IF;
  RETURN dispatched;
END;
$$;
INSERT INTO schema_migrations (version) VALUES ('031-realtime-background-audiences');
\else
\echo 'Skipping already-applied migration 031-realtime-background-audiences'
\endif
COMMIT;
