\set ON_ERROR_STOP on
\timing on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.plan_nodes(root JSONB)
RETURNS SETOF JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH RECURSIVE nodes(node) AS (
    SELECT root
    UNION ALL
    SELECT child
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(nodes.node->'Plans', '[]'::jsonb)
    ) AS child
  )
  SELECT node FROM nodes;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.unapproved_text_identifiers()
RETURNS TABLE(table_name NAME, column_name NAME, constraint_kind "char")
LANGUAGE sql
STABLE
AS $function$
  SELECT DISTINCT
    relation.relname,
    attribute.attname,
    constraint_record.contype
  FROM pg_constraint AS constraint_record
  INNER JOIN pg_class AS relation
    ON relation.oid = constraint_record.conrelid
  INNER JOIN LATERAL unnest(constraint_record.conkey) AS key(attnum) ON TRUE
  INNER JOIN pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum = key.attnum
  WHERE relation.relnamespace = 'public'::regnamespace
    AND constraint_record.contype IN ('p', 'f')
    AND attribute.atttypid = 'text'::regtype
  EXCEPT
  SELECT table_name, column_name, constraint_kind
  FROM legacy_text_identifier_columns;
$function$;

DO $schema_contract$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN (
        'users_username_trgm_idx',
        'users_display_name_trgm_idx',
        'invitations_username_trgm_idx'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'admin trigram index set is incomplete';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_temp.unapproved_text_identifiers()) THEN
    RAISE EXCEPTION 'an unapproved TEXT primary or foreign key bypassed the native-ID policy';
  END IF;
END
$schema_contract$;

CREATE TABLE policy_probe_text_id (id TEXT PRIMARY KEY);

DO $policy_probe$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_temp.unapproved_text_identifiers()
    WHERE table_name = 'policy_probe_text_id' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'identifier policy failed to detect a new TEXT primary key';
  END IF;
END
$policy_probe$;

DROP TABLE policy_probe_text_id;

DO $search_plans$
DECLARE
  user_plan JSONB;
  invitation_plan JSONB;
BEGIN
  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT id
    FROM users
    WHERE status <> 'deleting'
      AND (
        username ILIKE '%needle_target%' ESCAPE '\'
        OR COALESCE(display_name, '') ILIKE '%needle_target%' ESCAPE '\'
      )
    ORDER BY created_at, id
    LIMIT 51
  $query$ INTO user_plan;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(user_plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Index Name' IN (
      'users_username_trgm_idx', 'users_display_name_trgm_idx'
    )
  ) THEN
    RAISE EXCEPTION 'user substring plan did not use a trigram index: %', user_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    WITH candidate_ids AS MATERIALIZED (
      (
        SELECT invitations.id, invitations.created_at
        FROM invitations
        WHERE invitations.invited_username ILIKE '%needle_target%' ESCAPE '\'
        ORDER BY invitations.created_at DESC, invitations.id DESC
        LIMIT 51
      )
      UNION
      (
        SELECT invitations.id, invitations.created_at
        FROM users
        INNER JOIN invitations ON invitations.created_by = users.id
        WHERE users.status <> 'deleting'
          AND users.username ILIKE '%needle_target%' ESCAPE '\'
        ORDER BY invitations.created_at DESC, invitations.id DESC
        LIMIT 51
      )
    )
    SELECT invitations.id
    FROM candidate_ids
    INNER JOIN invitations ON invitations.id = candidate_ids.id
    ORDER BY candidate_ids.created_at DESC, candidate_ids.id DESC
    LIMIT 51
  $query$ INTO invitation_plan;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(invitation_plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Index Name' = 'invitations_username_trgm_idx'
  ) THEN
    RAISE EXCEPTION 'invitation substring plan did not use its trigram index: %', invitation_plan;
  END IF;
END
$search_plans$;

ROLLBACK;

\echo 'admin search and identifier policy regression checks passed'
