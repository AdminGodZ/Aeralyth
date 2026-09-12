\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id,username,password_hash,role) VALUES('usr_tree_balanced_plan','tree-balanced-plan','unused','user');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES('balanced-root','usr_tree_balanced_plan','root','balanced-root',0,'folder');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
SELECT 'balanced-folder-'||lpad(n::text,3,'0'),'usr_tree_balanced_plan','folder-'||n,'balanced/folder/'||n,0,'folder','balanced-root' FROM generate_series(1,256) n;
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,parent_id)
SELECT 'balanced-file-'||lpad(parent::text,3,'0')||'-'||lpad(child::text,3,'0'),'usr_tree_balanced_plan','file-'||child,'balanced/'||parent||'/'||child,1,'balanced-folder-'||lpad(parent::text,3,'0') FROM generate_series(1,256) parent CROSS JOIN generate_series(1,256) child;
ANALYZE files;
SELECT array_agg('balanced-folder-'||lpad(n::text,3,'0') ORDER BY n)::text AS parents FROM generate_series(1,256) n \gset
\echo CURRENT_GROUPED_DISCOVERY
EXPLAIN (ANALYZE,BUFFERS) SELECT child.id,child.parent_id,child.entry_type,parent.depth
FROM unnest(:'parents'::text[],array_fill(1,ARRAY[256]),array_fill(NULL::text,ARRAY[256])) AS parent(node_id,depth,last_child_id)
CROSS JOIN LATERAL (SELECT id,parent_id,entry_type FROM files WHERE owner_id='usr_tree_balanced_plan' AND parent_id=parent.node_id AND id>COALESCE(parent.last_child_id,'') ORDER BY id LIMIT 256) AS child
ORDER BY parent.depth,parent.node_id,child.id LIMIT 256;
\echo ONE_CHILD_PARENT_PROBE
EXPLAIN (ANALYZE,BUFFERS) SELECT parent.node_id,parent.depth,parent.last_child_id,child.id AS next_child_id
FROM unnest(:'parents'::text[],array_fill(1,ARRAY[256]),array_fill(NULL::text,ARRAY[256])) AS parent(node_id,depth,last_child_id)
LEFT JOIN LATERAL (SELECT id FROM files WHERE owner_id='usr_tree_balanced_plan' AND parent_id=parent.node_id AND id>COALESCE(parent.last_child_id,'') ORDER BY id LIMIT 1) AS child ON true;
\echo SINGLE_PARENT_PAYLOAD
EXPLAIN (ANALYZE,BUFFERS) SELECT id,parent_id,entry_type FROM files WHERE owner_id='usr_tree_balanced_plan' AND parent_id='balanced-folder-001' AND id>'' ORDER BY id LIMIT 256;
ROLLBACK;
