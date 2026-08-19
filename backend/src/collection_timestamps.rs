use deadpool_postgres::GenericClient;

use crate::db::execute_cached;

pub(crate) const TOUCH_ANCESTOR_COLLECTIONS_QUERY: &str = r#"
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids, 0::integer AS depth
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND entry_type = 'folder'
        AND state = 'active'

      UNION ALL

      SELECT parent.id, parent.parent_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = $2
        AND parent.entry_type = 'folder'
        AND parent.state = 'active'
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    ), touched_folders AS (
      UPDATE files AS folders
      SET updated_at = now()
      FROM ancestors
      WHERE folders.id = ancestors.id
        AND folders.owner_id = $2
      RETURNING folders.id
    )
    UPDATE repositories
    SET updated_at = now()
    WHERE owner_id = $2
      AND root_file_id IN (SELECT id FROM touched_folders)
"#;

/// Marks the containing folder chain, and any repository rooted in that chain,
/// as modified in the same transaction that publishes a file.
pub(crate) async fn touch_ancestor_collections<Client>(
    client: &Client,
    parent_id: Option<&str>,
    owner_id: &str,
) -> Result<(), tokio_postgres::Error>
where
    Client: GenericClient,
{
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    execute_cached(
        client,
        TOUCH_ANCESTOR_COLLECTIONS_QUERY,
        &[&parent_id, &owner_id],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
    use tokio_postgres::NoTls;

    use super::{TOUCH_ANCESTOR_COLLECTIONS_QUERY, touch_ancestor_collections};

    #[test]
    fn ancestor_collection_touch_is_scoped_and_cycle_bounded() {
        assert!(TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("owner_id = $2"));
        assert!(TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("state = 'active'"));
        assert!(TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("child.depth < 100"));
        assert!(
            TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("NOT parent.id = ANY(child.visited_ids)")
        );
        assert!(TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("UPDATE files AS folders"));
        assert!(TOUCH_ANCESTOR_COLLECTIONS_QUERY.contains("UPDATE repositories"));
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn touching_a_child_refreshes_folder_and_repository_timestamps() {
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
            .transaction()
            .await
            .expect("test transaction should start");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos()
            % 100_000_000;
        let owner_id = format!("usr_collection_touch_{suffix}");
        let username = format!("touch_{suffix}");
        let root_id = format!("fil_collection_root_{suffix}");
        let child_id = format!("fil_collection_child_{suffix}");
        let unrelated_id = format!("fil_collection_other_{suffix}");
        let repository_id = format!("repo_collection_touch_{suffix}");

        transaction
            .execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                 VALUES ($1, $2, 'not-a-login-hash', 'user', 'active')",
                &[&owner_id, &username],
            )
            .await
            .expect("owner fixture should insert");
        transaction
            .execute(
                "INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes,
                   entry_type, parent_id, updated_at
                 ) VALUES
                   ($1, $4, 'root', 'test-root', 0, 'folder', NULL, '2020-01-01'),
                   ($2, $4, 'child', 'test-child', 0, 'folder', $1, '2020-01-01'),
                   ($3, $4, 'other', 'test-other', 0, 'folder', NULL, '2020-01-01')",
                &[&root_id, &child_id, &unrelated_id, &owner_id],
            )
            .await
            .expect("folder fixtures should insert");
        transaction
            .execute(
                "INSERT INTO repositories (
                   id, owner_id, root_file_id, updated_at
                 ) VALUES ($1, $2, $3, '2020-01-01')",
                &[&repository_id, &owner_id, &root_id],
            )
            .await
            .expect("repository fixture should insert");

        touch_ancestor_collections(&transaction, Some(&child_id), &owner_id)
            .await
            .expect("ancestor timestamps should update");

        let rows = transaction
            .query(
                "SELECT id, updated_at > '2020-01-01'::timestamptz AS touched
                 FROM files
                 WHERE id = ANY($1::text[])",
                &[&vec![
                    root_id.clone(),
                    child_id.clone(),
                    unrelated_id.clone(),
                ]],
            )
            .await
            .expect("folder timestamps should load");
        let touched = rows
            .into_iter()
            .map(|row| (row.get::<_, String>("id"), row.get::<_, bool>("touched")))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(touched.get(&root_id), Some(&true));
        assert_eq!(touched.get(&child_id), Some(&true));
        assert_eq!(touched.get(&unrelated_id), Some(&false));

        let repository_touched: bool = transaction
            .query_one(
                "SELECT updated_at > '2020-01-01'::timestamptz AS touched
                 FROM repositories WHERE id = $1",
                &[&repository_id],
            )
            .await
            .expect("repository timestamp should load")
            .get("touched");
        assert!(repository_touched);

        transaction
            .rollback()
            .await
            .expect("test transaction should roll back");
    }
}
