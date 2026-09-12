\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '10s';
INSERT INTO users (id, username, password_hash, role) VALUES
  ('usr_hierarchy_update_a', 'hierarchy_update_a', 'unused', 'user'),
  ('usr_hierarchy_update_b', 'hierarchy_update_b', 'unused', 'user');
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type) VALUES
  ('fil_hu_root', 'usr_hierarchy_update_a', 'root', 'hu/root', 0, 'folder'),
  ('fil_hu_target', 'usr_hierarchy_update_a', 'target', 'hu/target', 0, 'folder'),
  ('fil_hu_other', 'usr_hierarchy_update_b', 'other', 'hu/other', 0, 'folder');
INSERT INTO files (id, owner_id, parent_id, original_name, storage_name, size_bytes, entry_type) VALUES
  ('fil_hu_child', 'usr_hierarchy_update_a', 'fil_hu_root', 'child', 'hu/child', 0, 'folder');
INSERT INTO files (id, owner_id, parent_id, original_name, storage_name, size_bytes, entry_type) VALUES
  ('fil_hu_leaf', 'usr_hierarchy_update_a', 'fil_hu_child', 'leaf', 'hu/leaf', 1, 'file');

-- Exercise NULL-to-parent and parent-to-NULL transitions with real guards.
UPDATE files SET parent_id = 'fil_hu_target' WHERE id = 'fil_hu_root';
UPDATE files SET parent_id = NULL WHERE id = 'fil_hu_root';
UPDATE files SET parent_id = parent_id, original_name = original_name WHERE id LIKE 'fil_hu_%';
UPDATE files SET parent_id = 'fil_hu_target' WHERE id = 'fil_hu_child';

-- Changing the owner must compare and lock both the previous and current owner.
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type) VALUES
  ('fil_hu_transfer', 'usr_hierarchy_update_a', 'transfer', 'hu/transfer', 1, 'file');
UPDATE files SET owner_id = 'usr_hierarchy_update_b' WHERE id = 'fil_hu_transfer';
UPDATE files SET owner_id = 'usr_hierarchy_update_a' WHERE id = 'fil_hu_transfer';

DO $$ BEGIN
  BEGIN
    UPDATE files SET owner_id = 'usr_hierarchy_update_b' WHERE id = 'fil_hu_leaf';
    RAISE EXCEPTION 'cross-owner child transfer was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE files SET parent_id = 'fil_hu_child' WHERE id = 'fil_hu_target';
    RAISE EXCEPTION 'cycle update was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE files SET parent_id = 'fil_hu_other' WHERE id = 'fil_hu_child';
    RAISE EXCEPTION 'cross-owner parent was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE files SET parent_id = 'fil_hu_leaf' WHERE id = 'fil_hu_root';
    RAISE EXCEPTION 'non-folder parent was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT parent_id FROM files WHERE id = 'fil_hu_child') <> 'fil_hu_target' THEN
    RAISE EXCEPTION 'rejected structural update did not roll back';
  END IF;
END $$;
ROLLBACK;
\echo 'hierarchy updates preserve valid moves, NULL parents, cycle, owner and parent-type checks'
