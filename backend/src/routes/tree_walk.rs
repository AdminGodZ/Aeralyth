use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use deadpool_postgres::GenericClient;

use crate::db::query_cached;

const TREE_PARENT_BATCH_SIZE: usize = 256;
const TREE_CHILD_PAGE_SIZE: i64 = 16_384;
pub(crate) const MAX_TREE_MUTATION_NODES: usize = 1_000_000;
pub(crate) const TREE_MUTATION_BATCH_SIZE: usize = 5_000;
const _: () = assert!(TREE_PARENT_BATCH_SIZE <= 256);
const _: () = assert!(TREE_CHILD_PAGE_SIZE <= 16_384);

const ROOT_QUERY: &str = "
    SELECT id, entry_type
    FROM files
    WHERE id = $1
      AND owner_id = $2
      AND ($3::text IS NULL OR state = $3)
      AND ($4::text IS NULL OR e2ee_state = $4)
    LIMIT 1
";

const CHILD_PAGE_QUERY: &str = "
    SELECT id, parent_id, entry_type
    FROM files
    WHERE owner_id = $1
      AND parent_id = ANY($2::text[])
      AND ($3::text IS NULL OR state = $3)
      AND ($4::text IS NULL OR e2ee_state = $4)
      AND (
        $5::text IS NULL
        OR (parent_id, id) > ($5, $6)
      )
    ORDER BY parent_id, id
    LIMIT $7
";
const UPDATE_TREE_STATE_QUERY: &str = "
    UPDATE files
    SET state = $3,
        trashed_at = CASE WHEN $3 = 'trashed' THEN now() ELSE NULL END,
        updated_at = now()
    WHERE owner_id = $2
      AND id = ANY($1::text[])
";

#[derive(Clone, Copy)]
pub(crate) struct TreeWalkScope<'a> {
    pub owner_id: &'a str,
    pub root_id: &'a str,
    pub root_state: Option<&'a str>,
    pub child_state: Option<&'a str>,
    pub e2ee_state: Option<&'a str>,
    pub max_nodes: usize,
}

#[derive(Clone)]
pub(crate) struct TreeWalkNode {
    pub id: String,
    pub depth: i32,
}

pub(crate) struct TreeWalk {
    pub nodes: Vec<TreeWalkNode>,
    pub truncated: bool,
}

pub(crate) async fn walk_subtree<Client>(
    client: &Client,
    scope: TreeWalkScope<'_>,
) -> Result<Option<TreeWalk>, tokio_postgres::Error>
where
    Client: GenericClient,
{
    let root = query_cached(
        client,
        ROOT_QUERY,
        &[
            &scope.root_id,
            &scope.owner_id,
            &scope.root_state,
            &scope.e2ee_state,
        ],
    )
    .await?
    .into_iter()
    .next();
    let Some(root) = root else {
        return Ok(None);
    };
    let root_id: String = root.get("id");
    let root_entry_type: String = root.get("entry_type");
    let mut nodes = vec![TreeWalkNode {
        id: root_id.clone(),
        depth: 0,
    }];
    let mut visited = HashSet::from([root_id.clone()]);
    let mut frontier = VecDeque::new();
    if root_entry_type == "folder" {
        frontier.push_back((root_id, 0_i32));
    }

    while !frontier.is_empty() {
        let mut parents = Vec::with_capacity(TREE_PARENT_BATCH_SIZE);
        let mut parent_depths = HashMap::with_capacity(TREE_PARENT_BATCH_SIZE);
        while parents.len() < TREE_PARENT_BATCH_SIZE {
            let Some((parent_id, depth)) = frontier.pop_front() else {
                break;
            };
            parent_depths.insert(parent_id.clone(), depth);
            parents.push(parent_id);
        }

        let mut cursor_parent: Option<String> = None;
        let mut cursor_id: Option<String> = None;
        loop {
            let rows = query_cached(
                client,
                CHILD_PAGE_QUERY,
                &[
                    &scope.owner_id,
                    &parents,
                    &scope.child_state,
                    &scope.e2ee_state,
                    &cursor_parent,
                    &cursor_id,
                    &TREE_CHILD_PAGE_SIZE,
                ],
            )
            .await?;
            let page_is_full = rows.len() == TREE_CHILD_PAGE_SIZE as usize;
            for row in rows {
                let id: String = row.get("id");
                let parent_id: String = row.get("parent_id");
                cursor_parent = Some(parent_id.clone());
                cursor_id = Some(id.clone());
                if !visited.insert(id.clone()) {
                    continue;
                }
                let depth = parent_depths.get(&parent_id).copied().unwrap_or_default() + 1;
                let entry_type: String = row.get("entry_type");
                if entry_type == "folder" && depth < 100 {
                    frontier.push_back((id.clone(), depth));
                }
                nodes.push(TreeWalkNode { id, depth });
                if nodes.len() > scope.max_nodes {
                    return Ok(Some(TreeWalk {
                        nodes,
                        truncated: true,
                    }));
                }
            }
            if !page_is_full {
                break;
            }
        }
    }

    Ok(Some(TreeWalk {
        nodes,
        truncated: false,
    }))
}

pub(crate) async fn update_tree_state<Client>(
    client: &Client,
    nodes: &[TreeWalkNode],
    owner_id: &str,
    state: &str,
) -> Result<(u64, usize, Duration), tokio_postgres::Error>
where
    Client: GenericClient,
{
    debug_assert!(matches!(state, "active" | "trashed"));
    let mut affected = 0_u64;
    let mut statements = 0_usize;
    let mut max_statement_elapsed = Duration::ZERO;
    for nodes in nodes.chunks(TREE_MUTATION_BATCH_SIZE) {
        let ids = nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        let statement_started = Instant::now();
        affected = affected.saturating_add(
            client
                .execute(UPDATE_TREE_STATE_QUERY, &[&ids, &owner_id, &state])
                .await?,
        );
        max_statement_elapsed = max_statement_elapsed.max(statement_started.elapsed());
        statements += 1;
    }
    Ok((affected, statements, max_statement_elapsed))
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
    use tokio_postgres::NoTls;

    use super::{
        CHILD_PAGE_QUERY, TREE_MUTATION_BATCH_SIZE, TreeWalkScope, update_tree_state, walk_subtree,
    };

    #[test]
    fn subtree_walk_queries_are_keyset_bounded() {
        assert!(CHILD_PAGE_QUERY.contains("(parent_id, id) > ($5, $6)"));
        assert!(CHILD_PAGE_QUERY.contains("LIMIT $7"));
        assert!(
            !CHILD_PAGE_QUERY
                .to_ascii_lowercase()
                .contains("with recursive")
        );
    }

    #[test]
    fn large_route_operations_do_not_reintroduce_recursive_subtree_statements() {
        for (name, source) in [
            ("files", include_str!("files.rs")),
            ("repositories", include_str!("repositories.rs")),
            ("share_links", include_str!("share_links.rs")),
            ("vault", include_str!("vault.rs")),
        ] {
            let normalized = source.to_ascii_lowercase();
            assert!(
                !normalized.contains("with recursive subtree")
                    && !normalized.contains("with recursive tree as"),
                "{name} reintroduced an unbounded recursive subtree statement"
            );
        }
        let database = include_str!("../db.rs");
        assert!(database.contains("statement_timeout=10000"));

        let files = include_str!("files.rs");
        assert_eq!(files.matches("walk_subtree(").count(), 3);
        assert!(
            files
                .matches(".isolation_level(IsolationLevel::RepeatableRead)")
                .count()
                >= 3
        );
        let share_links = include_str!("share_links.rs");
        assert_eq!(share_links.matches("walk_subtree(").count(), 1);
        assert!(share_links.contains(".isolation_level(IsolationLevel::RepeatableRead)"));
        let repositories = include_str!("repositories.rs");
        assert_eq!(repositories.matches("walk_subtree(").count(), 1);
        assert!(repositories.contains(".isolation_level(IsolationLevel::RepeatableRead)"));
        let vault = include_str!("vault.rs");
        assert_eq!(
            vault.matches("subtree_snapshot(&transaction").count(),
            6,
            "vault publications must retain their bounded read plus optimistic revalidation walks"
        );
        assert!(
            vault
                .matches(".isolation_level(IsolationLevel::RepeatableRead)")
                .count()
                >= 5
        );
    }

    #[actix_web::test]
    #[ignore = "requires the bounded-tree scale fixture"]
    async fn bounded_tree_walk_reaches_scale_fixture() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let postgres_config = database_url
            .parse::<tokio_postgres::Config>()
            .expect("database URL should parse");
        let manager = Manager::from_config(
            postgres_config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .build()
            .expect("test pool should build");
        let mut client = pool.get().await.expect("test database should connect");
        let transaction = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .start()
            .await
            .expect("test transaction should start");
        transaction
            .batch_execute("SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '3s';")
            .await
            .expect("production statement limits should apply");
        let expected_nodes = std::env::var("AERALYTH_TREE_EXPECTED_NODES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100_001);
        transaction
            .batch_execute(
                "INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes,
                   entry_type, parent_id, state
                 ) VALUES
                   ('fil_tree_nested_root', 'usr_tree_scale', 'nested-root',
                    'tree-scale/nested-root', 0, 'folder', NULL, 'active'),
                   ('fil_tree_nested_folder', 'usr_tree_scale', 'nested-folder',
                    'tree-scale/nested-folder', 0, 'folder',
                    'fil_tree_nested_root', 'active'),
                   ('fil_tree_nested_leaf', 'usr_tree_scale', 'nested-leaf',
                    'tree-scale/nested-leaf', 1, 'file',
                    'fil_tree_nested_folder', 'active'),
                   ('fil_tree_nested_trashed', 'usr_tree_scale', 'nested-trashed',
                    'tree-scale/nested-trashed', 1, 'file',
                    'fil_tree_nested_folder', 'trashed');",
            )
            .await
            .expect("nested tree fixture should insert");
        let nested = walk_subtree(
            &transaction,
            TreeWalkScope {
                owner_id: "usr_tree_scale",
                root_id: "fil_tree_nested_root",
                root_state: Some("active"),
                child_state: Some("active"),
                e2ee_state: None,
                max_nodes: 10,
            },
        )
        .await
        .expect("nested tree walk should execute")
        .expect("nested root should exist");
        let nested_depths = nested
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.depth))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(nested_depths.len(), 3);
        assert_eq!(nested_depths.get("fil_tree_nested_root"), Some(&0));
        assert_eq!(nested_depths.get("fil_tree_nested_folder"), Some(&1));
        assert_eq!(nested_depths.get("fil_tree_nested_leaf"), Some(&2));
        assert!(!nested_depths.contains_key("fil_tree_nested_trashed"));
        let walk_started = Instant::now();
        let walk = walk_subtree(
            &transaction,
            TreeWalkScope {
                owner_id: "usr_tree_scale",
                root_id: "fil_tree_scale_root",
                root_state: Some("active"),
                child_state: Some("active"),
                e2ee_state: None,
                max_nodes: expected_nodes,
            },
        )
        .await
        .expect("bounded tree walk should execute")
        .expect("scale root should exist");
        let walk_elapsed = walk_started.elapsed();
        assert!(!walk.truncated);
        assert_eq!(walk.nodes.len(), expected_nodes);
        let mutation_started = Instant::now();
        let (trashed, trash_statements, trash_max_statement) =
            update_tree_state(&transaction, &walk.nodes, "usr_tree_scale", "trashed")
                .await
                .expect("bounded trash batches should execute");
        assert_eq!(trashed as usize, expected_nodes);
        assert_eq!(
            trash_statements,
            expected_nodes.div_ceil(TREE_MUTATION_BATCH_SIZE)
        );
        let (restored, restore_statements, restore_max_statement) =
            update_tree_state(&transaction, &walk.nodes, "usr_tree_scale", "active")
                .await
                .expect("bounded restore batches should execute");
        assert_eq!(restored as usize, expected_nodes);
        assert_eq!(restore_statements, trash_statements);
        let mutation_elapsed = mutation_started.elapsed();
        let delete_ids = walk
            .nodes
            .iter()
            .skip(1)
            .take(TREE_MUTATION_BATCH_SIZE)
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        let delete_started = Instant::now();
        let deleted = transaction
            .query_one(
                crate::routes::files::DELETE_TREE_BATCH_QUERY,
                &[&delete_ids, &"usr_tree_scale"],
            )
            .await
            .expect("bounded storage-queue deletion batch should execute")
            .get::<_, i64>("deleted");
        let delete_elapsed = delete_started.elapsed();
        assert_eq!(deleted as usize, delete_ids.len());
        eprintln!(
            "bounded tree scale: {expected_nodes} nodes; walk={walk_elapsed:?}; trash+restore={mutation_elapsed:?}; mutation_statements={}; slowest_mutation_statement={:?}; delete_batch={delete_elapsed:?}",
            trash_statements + restore_statements,
            trash_max_statement.max(restore_max_statement)
        );
        transaction
            .rollback()
            .await
            .expect("test transaction should roll back");
    }
}
