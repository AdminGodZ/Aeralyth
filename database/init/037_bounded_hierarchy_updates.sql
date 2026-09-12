\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:037-bounded-hierarchy-updates', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '037-bounded-hierarchy-updates'
) AS apply_migration \gset
\if :apply_migration

CREATE OR REPLACE FUNCTION validate_updated_file_hierarchy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  changed_ids TEXT[];
  owner_ids TEXT[];
  owner_key TEXT;
BEGIN
  -- Transition tables have no indexes. Joining their IDs can compare every
  -- old row with every new row, even for a state-only or no-op update. EXCEPT
  -- compares the structural projections and treats NULL parents as equal.
  WITH previous_structure AS MATERIALIZED (
    SELECT id, owner_id, parent_id, entry_type FROM old_files
  ), current_structure AS MATERIALIZED (
    SELECT id, owner_id, parent_id, entry_type FROM updated_files
  ), changed AS MATERIALIZED (
    (SELECT * FROM previous_structure EXCEPT SELECT * FROM current_structure)
    UNION ALL
    (SELECT * FROM current_structure EXCEPT SELECT * FROM previous_structure)
  )
  SELECT array_agg(DISTINCT id ORDER BY id),
         array_agg(DISTINCT owner_id ORDER BY owner_id)
  INTO changed_ids, owner_ids
  FROM changed;

  IF changed_ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- Preserve the existing lock order and include both previous and new owners.
  FOREACH owner_key IN ARRAY owner_ids LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('aeralyth:file-hierarchy:' || owner_key, 0)
    );
  END LOOP;
  PERFORM assert_file_hierarchy_valid(changed_ids);
  RETURN NULL;
END;
$$;

INSERT INTO schema_migrations (version)
VALUES ('037-bounded-hierarchy-updates');
\endif
COMMIT;
