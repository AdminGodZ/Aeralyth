\set ON_ERROR_STOP on
SELECT array_agg('tree-job-branch-'||n ORDER BY 'tree-job-branch-'||n)::text AS parents FROM generate_series(1,256) n \gset
EXPLAIN (ANALYZE,BUFFERS) SELECT child.id,child.parent_id,child.entry_type,parent.depth,(parent.ordinality-1)::integer AS parent_index
FROM unnest(:'parents'::text[],array_fill(1,ARRAY[256]),array_fill(NULL::text,ARRAY[256]),array_fill(1,ARRAY[256])) WITH ORDINALITY AS parent(node_id,depth,last_child_id,quota,ordinality)
LEFT JOIN LATERAL (SELECT id,parent_id,entry_type FROM files WHERE owner_id='usr_tree_job_test' AND parent_id=parent.node_id AND id > COALESCE(parent.last_child_id,'') ORDER BY id LIMIT parent.quota) AS child ON true
ORDER BY parent.ordinality,child.id;
