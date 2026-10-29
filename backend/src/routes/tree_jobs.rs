//! Large tree mutations publish a durable root fence and advance in short transactions.
//! The HTTP path only probes a small tree. Workers never retain the entire tree in RAM.
use std::collections::HashSet;
use std::time::Duration;

use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use deadpool_postgres::GenericClient;
use tokio::sync::watch;

use crate::auth::require_principal;
use crate::db::{
    Database, DatabaseError, execute_cached, query_cached, query_one_cached, query_opt_cached,
};
use crate::state::AppState;

use super::files::DELETE_TREE_BATCH_QUERY;
use super::tree_walk::{TreeWalkNode, TreeWalkScope, update_tree_state, walk_subtree};

pub(crate) const SYNC_NODE_LIMIT: usize = 256;
const JOB_BATCH_SIZE: i64 = 256;
const OPERATION_DEADLINE: Duration = Duration::from_secs(3);
const IDLE_POLL_MIN: Duration = Duration::from_millis(500);
const IDLE_POLL_MAX: Duration = Duration::from_secs(5);

/// Starts this process's worker as soon as a request commits a job. Polling
/// still covers jobs queued by another replica and delayed retries.
static WORKER_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

#[derive(Clone, Copy)]
pub(crate) enum Action {
    Trash,
    Restore,
    Delete,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Trash => "trash",
            Self::Restore => "restore",
            Self::Delete => "delete",
        }
    }

    fn root_state(self) -> &'static str {
        match self {
            Self::Trash => "active",
            Self::Restore | Self::Delete => "trashed",
        }
    }
}

pub(crate) struct EditorAuthorization<'a> {
    pub id: &'a str,
    pub token: &'a str,
    pub access_scope: &'a str,
    pub recipient_id: Option<&'a str>,
}

pub(crate) enum MutationResult {
    Complete,
    Missing,
    Queued(i64),
}

/// Caller authenticates the actor first. A shared-link caller also supplies its
/// grant ID so authorization is checked again under the publication lock.
pub(crate) async fn mutate(
    db: &Database,
    owner_id: &str,
    root_id: &str,
    action: Action,
    child_state: Option<&str>,
    editor_grant: Option<EditorAuthorization<'_>>,
) -> Result<MutationResult> {
    let mut client = db.get().await.map_err(crate::db::http_error)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let result = tokio::time::timeout(OPERATION_DEADLINE, async {
        transaction.batch_execute("SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '1s';").await.map_err(retryable_database_error)?;
        // This lock lasts only for admission and at most 256 synchronous nodes.
        // All physical writers take the shared side in the database guard.
        query_one_cached(&transaction, "SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:tree-operation:' || $1::text, 0))",
            &[&owner_id],
        ).await.map_err(retryable_database_error)?;
        if let Some(job) = query_opt_cached(&transaction, "SELECT id, root_id, action FROM tree_operation_jobs WHERE owner_id = $1 AND status IN ('pending','running')",
            &[&owner_id],
        ).await.map_err(retryable_database_error)? {
            if job.get::<_, String>("root_id") == root_id && job.get::<_, String>("action") == action.as_str() {
                return Ok(MutationResult::Queued(job.get("id")));
            }
            return Err(error::ErrorConflict("another tree operation is still processing"));
        }
        let root = query_opt_cached(&transaction, "SELECT id FROM visible_files AS files WHERE id = $1 AND owner_id = $2 AND state = $3 FOR UPDATE",
            &[&root_id, &owner_id, &action.root_state()],
        ).await.map_err(retryable_database_error)?;
        if root.is_none() {
            return Ok(MutationResult::Missing);
        }
        if matches!(action, Action::Restore) {
            let invalid_parent: bool = query_one_cached(&transaction, "SELECT EXISTS(SELECT 1 FROM files AS node JOIN files AS parent ON parent.id = node.parent_id WHERE node.id = $1 AND (parent.owner_id <> $2 OR parent.state <> 'active' OR NOT tree_operation_visible(parent.id, parent.owner_id)))",
                &[&root_id, &owner_id],
            ).await.map_err(retryable_database_error)?.get(0);
            if invalid_parent {
                return Err(error::ErrorConflict("restore the parent folder first"));
            }
        }
        if let Some(grant) = editor_grant {
            let authorized = query_opt_cached(&transaction, "WITH RECURSIVE ancestors AS (
                    SELECT id,parent_id,ARRAY[id]::text[] AS visited_ids,0 AS depth FROM visible_files AS files WHERE id=$1 AND owner_id=$2 AND state='active'
                    UNION ALL SELECT parent.id,parent.parent_id,child.visited_ids || parent.id,child.depth+1
                    FROM visible_files AS parent JOIN ancestors AS child ON parent.id=child.parent_id
                    WHERE parent.owner_id=$2 AND parent.state='active' AND child.depth < 100 AND NOT parent.id=ANY(child.visited_ids)
                 ) SELECT links.id FROM share_links AS links JOIN ancestors ON ancestors.id=links.root_file_id
                   WHERE links.id=$3 AND links.owner_id=$2 AND links.permission='editor' AND links.revoked_at IS NULL
                     AND (links.expires_at IS NULL OR links.expires_at > now()) AND links.root_file_id <> $1 AND links.token_hash=encode(digest($4::text,'sha256'),'hex') AND links.access_scope=$5 AND links.recipient_id IS NOT DISTINCT FROM $6 FOR SHARE OF links",
                &[&root_id, &owner_id, &grant.id, &grant.token, &grant.access_scope, &grant.recipient_id],
            ).await.map_err(retryable_database_error)?;
            if authorized.is_none() {
                return Err(error::ErrorForbidden("share authorization changed"));
            }
        }
        let tree = walk_subtree(&transaction, TreeWalkScope {
            owner_id, root_id, root_state: Some(action.root_state()), child_state,
            e2ee_state: None, max_nodes: SYNC_NODE_LIMIT,
        }).await.map_err(retryable_database_error)?;
        let Some(mut tree) = tree else { return Ok(MutationResult::Missing); };
        let mut requires_job = tree.truncated;
        if !requires_job && matches!(action,Action::Delete) {
            transaction.batch_execute("SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
            let ids = tree.nodes.iter().map(|node| node.id.as_str()).collect::<Vec<_>>();
            let mut ready = false;
            for _ in 0..8 {
                ready = query_one_cached(&transaction, "SELECT tree_operation_drain_dependencies($1,$2,$3)", &[&owner_id,&ids,&256_i32]).await.map_err(retryable_database_error)?.get(0);
                if ready { break; }
            }
            if !ready {
                transaction.batch_execute("ROLLBACK TO SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
                requires_job = true;
            }
            transaction.batch_execute("RELEASE SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
        }
        if requires_job {
            let id: i64 = query_one_cached(&transaction, "INSERT INTO tree_operation_jobs(owner_id,root_id,action,child_state) VALUES($1,$2,$3,$4) RETURNING id",
                &[&owner_id, &root_id, &action.as_str(), &child_state],
            ).await.map_err(retryable_database_error)?.get(0);
            execute_cached(&transaction, "INSERT INTO tree_operation_nodes(job_id,node_id,parent_id,depth,entry_type,expanded)
                 SELECT $1,id,parent_id,0,entry_type,entry_type <> 'folder' FROM files WHERE id=$2 AND owner_id=$3",
                &[&id, &root_id, &owner_id],
            ).await.map_err(retryable_database_error)?;
            // Publication changes collection revisions even before the first worker batch.
            execute_cached(&transaction, "SELECT set_config('aeralyth.tree_job_id',$1,true)", &[&id.to_string()]).await.map_err(retryable_database_error)?;
            execute_cached(&transaction, "UPDATE files SET updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2", &[&root_id,&owner_id]).await.map_err(retryable_database_error)?;
            return Ok(MutationResult::Queued(id));
        }
        match action {
            Action::Trash | Action::Restore => {
                update_tree_state(&transaction, &tree.nodes, owner_id, if matches!(action,Action::Trash) { "trashed" } else { "active" }).await.map_err(retryable_database_error)?;
            }
            Action::Delete => {
                tree.nodes.sort_unstable_by(|a,b| b.depth.cmp(&a.depth).then(a.id.cmp(&b.id)));
                let ids = tree.nodes.iter().map(|node| node.id.as_str()).collect::<Vec<_>>();
                query_one_cached(&transaction, DELETE_TREE_BATCH_QUERY, &[&ids, &owner_id]).await.map_err(retryable_database_error)?;
            }
        }
        Ok::<_, actix_web::Error>(MutationResult::Complete)
    }).await;
    match result {
        Ok(Ok(outcome)) => {
            transaction
                .commit()
                .await
                .map_err(error::ErrorInternalServerError)?;
            if matches!(outcome, MutationResult::Queued(_)) {
                WORKER_WAKE.notify_one();
            }
            Ok(outcome)
        }
        Ok(Err(error)) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
        Err(_) => {
            // Explicit rollback also cancels a timed-out synchronous operation.
            let _ = transaction.rollback().await;
            Err(error::ErrorServiceUnavailable(
                "tree operation admission timed out; retry",
            ))
        }
    }
}

pub(crate) const BATCH_ROOT_LIMIT: usize = 256;

#[derive(Debug, Default)]
pub(crate) struct BatchMutation {
    pub completed: Vec<String>,
    pub missing: Vec<String>,
    /// Roots the caller must retry one by one through `mutate`: they need a
    /// durable job, a precise conflict, or another job already holds the owner.
    pub deferred: Vec<String>,
}

/// Applies one owner action to many selected roots in one synchronous
/// transaction, sharing `mutate`'s lock, deadline and 256-node budget. Roots
/// that do not fit are deferred untouched, so large trees keep their durable
/// job path and its progress polling.
pub(crate) async fn mutate_many(
    db: &Database,
    owner_id: &str,
    root_ids: &[String],
    action: Action,
) -> Result<BatchMutation> {
    debug_assert!(root_ids.len() <= BATCH_ROOT_LIMIT);
    let mut client = db.get().await.map_err(crate::db::http_error)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let result = tokio::time::timeout(OPERATION_DEADLINE, async {
        transaction.batch_execute("SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '1s';").await.map_err(retryable_database_error)?;
        query_one_cached(&transaction, "SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:tree-operation:' || $1::text, 0))",
            &[&owner_id],
        ).await.map_err(retryable_database_error)?;
        let mut batch = BatchMutation::default();
        if query_opt_cached(&transaction, "SELECT id FROM tree_operation_jobs WHERE owner_id = $1 AND status IN ('pending','running')",
            &[&owner_id],
        ).await.map_err(retryable_database_error)?.is_some() {
            batch.deferred = root_ids.to_vec();
            return Ok(batch);
        }
        let found = query_cached(&transaction, "SELECT id FROM visible_files AS files WHERE id = ANY($1::text[]) AND owner_id = $2 AND state = $3 ORDER BY id FOR UPDATE",
            &[&root_ids, &owner_id, &action.root_state()],
        ).await.map_err(retryable_database_error)?
            .into_iter().map(|row| row.get::<_, String>("id")).collect::<HashSet<_>>();
        let blocked = if matches!(action, Action::Restore) {
            query_cached(&transaction, "SELECT node.id FROM files AS node JOIN files AS parent ON parent.id = node.parent_id WHERE node.id = ANY($1::text[]) AND (parent.owner_id <> $2 OR parent.state <> 'active' OR NOT tree_operation_visible(parent.id, parent.owner_id))",
                &[&root_ids, &owner_id],
            ).await.map_err(retryable_database_error)?
                .into_iter().map(|row| row.get::<_, String>("id")).collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };

        let mut seen = HashSet::new();
        let mut nodes: Vec<TreeWalkNode> = Vec::new();
        for root_id in root_ids {
            if !found.contains(root_id) {
                batch.missing.push(root_id.clone());
            } else if blocked.contains(root_id) {
                batch.deferred.push(root_id.clone());
            } else if seen.contains(root_id) {
                // A selected descendant of an earlier selected root.
                batch.completed.push(root_id.clone());
            } else {
                let budget = SYNC_NODE_LIMIT.saturating_sub(seen.len());
                let tree = if budget == 0 { None } else {
                    walk_subtree(&transaction, TreeWalkScope {
                        owner_id, root_id, root_state: Some(action.root_state()), child_state: None,
                        e2ee_state: None, max_nodes: budget,
                    }).await.map_err(retryable_database_error)?
                };
                match tree {
                    Some(tree) if !tree.truncated => {
                        for node in tree.nodes {
                            if seen.insert(node.id.clone()) {
                                nodes.push(node);
                            }
                        }
                        batch.completed.push(root_id.clone());
                    }
                    _ => batch.deferred.push(root_id.clone()),
                }
            }
        }
        if nodes.is_empty() {
            return Ok(batch);
        }
        match action {
            Action::Trash | Action::Restore => {
                update_tree_state(&transaction, &nodes, owner_id, if matches!(action,Action::Trash) { "trashed" } else { "active" }).await.map_err(retryable_database_error)?;
            }
            Action::Delete => {
                let ids = nodes.iter().map(|node| node.id.as_str()).collect::<Vec<_>>();
                transaction.batch_execute("SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
                let mut ready = false;
                for _ in 0..8 {
                    ready = query_one_cached(&transaction, "SELECT tree_operation_drain_dependencies($1,$2,$3)", &[&owner_id,&ids,&256_i32]).await.map_err(retryable_database_error)?.get(0);
                    if ready { break; }
                }
                if !ready {
                    // Per-root deletion can fall back to a durable job.
                    transaction.batch_execute("ROLLBACK TO SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
                    batch.deferred.append(&mut batch.completed);
                    return Ok(batch);
                }
                transaction.batch_execute("RELEASE SAVEPOINT small_tree_dependencies").await.map_err(retryable_database_error)?;
                // One statement: foreign keys see the whole set at once.
                query_one_cached(&transaction, DELETE_TREE_BATCH_QUERY, &[&ids, &owner_id]).await.map_err(retryable_database_error)?;
            }
        }
        Ok::<_, actix_web::Error>(batch)
    }).await;
    match result {
        Ok(Ok(batch)) => {
            transaction
                .commit()
                .await
                .map_err(error::ErrorInternalServerError)?;
            Ok(batch)
        }
        Ok(Err(error)) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
        Err(_) => {
            let _ = transaction.rollback().await;
            Err(error::ErrorServiceUnavailable(
                "tree operation admission timed out; retry",
            ))
        }
    }
}

fn retryable_database_error(error: tokio_postgres::Error) -> actix_web::Error {
    match error.code().map(tokio_postgres::error::SqlState::code) {
        Some("55P03" | "40P01" | "40001" | "57014") => {
            error::ErrorServiceUnavailable("tree operation temporarily busy; retry")
        }
        Some("55000") => error::ErrorConflict("tree operation is still processing"),
        _ => error::ErrorInternalServerError(error),
    }
}

pub(crate) fn queued_response(job_id: i64, file_id: &str) -> HttpResponse {
    HttpResponse::Accepted()
        .insert_header(("Cache-Control", "private, no-store"))
        .insert_header(("Retry-After", "1"))
        .json(serde_json::json!({"status":"queued","fileId":file_id,"jobId":job_id.to_string()}))
}

pub(crate) async fn status(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<i64>,
) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let row = state.db.query_opt(
        "SELECT id,root_id,action,status,processed_nodes,last_error FROM tree_operation_jobs WHERE id=$1 AND owner_id=$2",
        &[&path.into_inner(), &user.id],
    ).await.map_err(crate::db::http_error)?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    Ok(HttpResponse::Ok().insert_header(("Cache-Control", "private, no-store"))
        .json(serde_json::json!({"jobId":row.get::<_,i64>("id").to_string(),"fileId":row.get::<_,String>("root_id"),"action":row.get::<_,String>("action"),"status":row.get::<_,String>("status"),"processedNodes":row.get::<_,i64>("processed_nodes"),"retrying":row.get::<_,Option<String>>("last_error").is_some()})))
}

fn discovery_quotas(parent_count: usize) -> Vec<i32> {
    assert!(parent_count > 0 && parent_count <= JOB_BATCH_SIZE as usize);
    let base = JOB_BATCH_SIZE as usize / parent_count;
    let remainder = JOB_BATCH_SIZE as usize % parent_count;
    (0..parent_count)
        .map(|index| (base + usize::from(index < remainder)) as i32)
        .collect()
}

/// Each call commits one persistent cursor page or physical mutation batch.
async fn process_batch(db: &Database) -> Result<bool, DatabaseError> {
    let mut client = db.get().await?;
    let transaction = client.transaction().await?;
    transaction
        .batch_execute("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='500ms';")
        .await?;
    let audience = query_cached(&transaction, "SELECT delta.job_id,delta.owner_id FROM tree_operation_counter_deltas AS delta JOIN tree_operation_jobs AS jobs ON jobs.id=delta.job_id WHERE jobs.status='complete' ORDER BY delta.job_id,delta.owner_id LIMIT $1 FOR UPDATE OF delta SKIP LOCKED", &[&16_i64]).await?;
    for target in &audience {
        let owner: String = target.get("owner_id");
        let id: i64 = target.get("job_id");
        query_one_cached(
            &transaction,
            "SELECT realtime_enqueue($1,'files'),realtime_enqueue($1,'shared')",
            &[&owner],
        )
        .await?;
        execute_cached(
            &transaction,
            "DELETE FROM tree_operation_counter_deltas WHERE job_id=$1 AND owner_id=$2",
            &[&id, &owner],
        )
        .await?;
    }

    let job = query_opt_cached(&transaction,
        "SELECT id,owner_id,root_id,action,child_state,phase FROM tree_operation_jobs WHERE status IN ('pending','running') AND available_at <= now() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", &[]).await?;
    let Some(job) = job else {
        execute_cached(&transaction, "DELETE FROM tree_operation_jobs WHERE id IN (SELECT jobs.id FROM tree_operation_jobs AS jobs WHERE jobs.status='complete' AND jobs.completed_at < now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM tree_operation_counter_deltas AS delta WHERE delta.job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM tree_operation_nodes AS nodes WHERE nodes.job_id=jobs.id) ORDER BY jobs.id LIMIT 256)", &[]).await?;
        transaction.commit().await?;
        return Ok(!audience.is_empty());
    };
    let job_id: i64 = job.get("id");
    let result = tokio::time::timeout(OPERATION_DEADLINE, async {
    let owner_id: String = job.get("owner_id");
    let root_id: String = job.get("root_id");
    let action: String = job.get("action");
    execute_cached(&transaction, "SELECT set_config('aeralyth.tree_job_id',$1,true)",
            &[&job_id.to_string()],
        )
        .await?;
    execute_cached(&transaction, "UPDATE tree_operation_jobs SET status='running',available_at=clock_timestamp(),updated_at=now(),last_error=NULL WHERE id=$1", &[&job_id]).await?;
    if job.get::<_, String>("phase") == "discover" {
        let parents = query_cached(&transaction, "SELECT node_id,depth,last_child_id FROM tree_operation_nodes WHERE job_id=$1 AND NOT expanded ORDER BY depth,node_id LIMIT $2", &[&job_id,&JOB_BATCH_SIZE]).await?;
        if parents.is_empty() {
            execute_cached(&transaction, "UPDATE tree_operation_jobs SET phase='mutate' WHERE id=$1", &[&job_id]).await?;
        } else {
            let parent_ids = parents.iter().map(|row| row.get::<_,String>("node_id")).collect::<Vec<_>>();
            let child_state: Option<String> = job.get("child_state");
            let parent_depths = parents.iter().map(|row| row.get::<_,i32>("depth")).collect::<Vec<_>>();
            let parent_cursors = parents.iter().map(|row| row.get::<_,Option<String>>("last_child_id")).collect::<Vec<_>>();
            // Divide the total row budget across parents. An outer LIMIT over
            // 256 children per parent would repeatedly read up to 65,536 rows.
            let quotas = discovery_quotas(parents.len());
            let children = query_cached(&transaction, "SELECT child.id,child.parent_id,child.entry_type,parent.depth,(parent.ordinality-1)::integer AS parent_index FROM unnest($2::text[],$3::integer[],$4::text[],$6::integer[]) WITH ORDINALITY AS parent(node_id,depth,last_child_id,quota,ordinality) LEFT JOIN LATERAL (SELECT id,parent_id,entry_type FROM files WHERE owner_id=$1 AND parent_id=parent.node_id AND id > COALESCE(parent.last_child_id,'') AND ($5::text IS NULL OR state=$5) ORDER BY id LIMIT parent.quota) AS child ON true ORDER BY parent.ordinality,child.id", &[&owner_id,&parent_ids,&parent_depths,&parent_cursors,&child_state,&quotas]).await?;
            let mut child_counts = vec![0_usize; parents.len()];
            let mut last_ids = vec![None::<String>; parents.len()];
            let mut ids = Vec::with_capacity(children.len());
            let mut child_parents = Vec::with_capacity(children.len());
            let mut kinds = Vec::with_capacity(children.len());
            let mut depths = Vec::with_capacity(children.len());
            for child in &children {
                let Some(id) = child.get::<_,Option<String>>("id") else { continue; };
                let index = child.get::<_,i32>("parent_index") as usize;
                child_counts[index] += 1;
                last_ids[index] = Some(id.clone());
                ids.push(id);
                child_parents.push(child.get::<_,String>("parent_id"));
                kinds.push(child.get::<_,String>("entry_type"));
                depths.push(child.get::<_,i32>("depth") + 1);
            }
            if !ids.is_empty() {
                execute_cached(&transaction, "INSERT INTO tree_operation_nodes(job_id,node_id,parent_id,depth,entry_type,expanded) SELECT $1,node_id,parent_id,depth,entry_type,entry_type <> 'folder' FROM unnest($2::text[],$3::text[],$4::integer[],$5::text[]) AS nodes(node_id,parent_id,depth,entry_type) ON CONFLICT(job_id,node_id) DO NOTHING", &[&job_id,&ids,&child_parents,&depths,&kinds]).await?;
            }
            let mut expanded_ids = Vec::new();
            let mut cursor_parent_ids = Vec::new();
            let mut cursor_child_ids = Vec::new();
            for (index,parent_id) in parent_ids.iter().enumerate() {
                if child_counts[index] < quotas[index] as usize {
                    expanded_ids.push(parent_id.clone());
                } else {
                    cursor_parent_ids.push(parent_id.clone());
                    cursor_child_ids.push(last_ids[index].take().expect("full parent quota has a last child"));
                }
            }
            if !expanded_ids.is_empty() {
                execute_cached(&transaction, "UPDATE tree_operation_nodes SET expanded=true WHERE job_id=$1 AND node_id=ANY($2::text[])", &[&job_id,&expanded_ids]).await?;
            }
            if !cursor_parent_ids.is_empty() {
                execute_cached(&transaction, "UPDATE tree_operation_nodes AS nodes SET last_child_id=cursor.last_child_id FROM unnest($2::text[],$3::text[]) AS cursor(node_id,last_child_id) WHERE nodes.job_id=$1 AND nodes.node_id=cursor.node_id", &[&job_id,&cursor_parent_ids,&cursor_child_ids]).await?;
            }
        }
    } else {
        let nodes = query_cached(&transaction, "SELECT node_id FROM tree_operation_nodes WHERE job_id=$1 AND NOT processed ORDER BY depth DESC,node_id LIMIT $2", &[&job_id,&JOB_BATCH_SIZE]).await?;
        if nodes.is_empty() {
            // Change the root revision in the same transaction that removes the fence.
            execute_cached(&transaction, "UPDATE files SET updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2",
                    &[&root_id, &owner_id],
                )
                .await?;
            execute_cached(&transaction, "UPDATE tree_operation_jobs SET status='complete',completed_at=now(),updated_at=now() WHERE id=$1", &[&job_id]).await?;
            query_one_cached(&transaction, "SELECT realtime_enqueue($1,'files'),realtime_enqueue($1,'repositories')", &[&owner_id]).await?;
        } else {
            let ids = nodes
                .iter()
                .map(|row| row.get::<_, String>("node_id"))
                .collect::<Vec<_>>();
            if action == "delete" {
                let ready: bool = query_one_cached(&transaction, "SELECT tree_operation_drain_dependencies($1,$2,$3)", &[&owner_id,&ids,&256_i32]).await?.get(0);
                if !ready {
                    execute_cached(&transaction, "UPDATE tree_operation_jobs SET available_at=clock_timestamp(),updated_at=now() WHERE id=$1", &[&job_id]).await?;
                    return Ok(());
                }
                query_one_cached(&transaction, DELETE_TREE_BATCH_QUERY, &[&ids, &owner_id])
                    .await?;
            } else {
                let new_state = if action == "trash" {
                    "trashed"
                } else {
                    "active"
                };
                execute_cached(&transaction, "UPDATE files SET state=$3,trashed_at=CASE WHEN $3='trashed' THEN now() ELSE NULL END,updated_at=now() WHERE owner_id=$2 AND id=ANY($1::text[])", &[&ids,&owner_id,&new_state]).await?;
            }
            execute_cached(&transaction, "DELETE FROM tree_operation_nodes WHERE job_id=$1 AND node_id=ANY($2::text[])", &[&job_id,&ids]).await?;
            execute_cached(&transaction, "UPDATE tree_operation_jobs SET processed_nodes=processed_nodes+$2,available_at=clock_timestamp(),updated_at=now() WHERE id=$1", &[&job_id,&(ids.len() as i64)]).await?;
        }
    }
        Ok::<_,tokio_postgres::Error>(())
    }).await;
    match result {
        Ok(Ok(())) => {}
        failure => {
            let message = match failure {
                Ok(Err(error)) => error.to_string(),
                Err(_) => "tree operation batch deadline exceeded".to_owned(),
                _ => unreachable!(),
            };
            transaction.rollback().await?;
            drop(client);
            db.execute("UPDATE tree_operation_jobs SET attempts=attempts+1,last_error=$2,available_at=now()+make_interval(secs=>LEAST(60,POWER(2,LEAST(attempts,5))::int)),updated_at=now() WHERE id=$1 AND status IN ('pending','running')", &[&job_id,&message]).await?;
            tracing::warn!(job_id,%message,"tree operation batch rolled back; cursor retained for retry");
            return Ok(false);
        }
    }
    transaction.commit().await?;
    Ok(true)
}

/// Idle polls back off so an empty queue costs a transaction every few seconds,
/// not twice a second. Locally queued jobs wake the worker immediately.
fn next_idle_poll(current: Duration) -> Duration {
    current.saturating_mul(2).min(IDLE_POLL_MAX)
}

pub(crate) async fn run(db: Database, mut shutdown: watch::Receiver<bool>) {
    let mut idle_poll = IDLE_POLL_MIN;
    loop {
        if *shutdown.borrow() {
            break;
        }
        // This outer deadline also bounds completion delivery and job checkout.
        let delay = match tokio::time::timeout(Duration::from_secs(4), process_batch(&db)).await {
            Ok(Ok(true)) => {
                idle_poll = IDLE_POLL_MIN;
                Duration::from_millis(1)
            }
            Ok(Ok(false)) => {
                let delay = idle_poll;
                idle_poll = next_idle_poll(idle_poll);
                delay
            }
            failure => {
                tracing::warn!(
                    ?failure,
                    "tree operation batch rolled back; durable cursor will resume"
                );
                Duration::from_secs(2)
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = WORKER_WAKE.notified() => { idle_poll = IDLE_POLL_MIN; },
            _ = shutdown.changed() => { if *shutdown.borrow() { break; } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::{DatabasePoolSettings, PoolRole};
    use crate::observability::Metrics;
    use std::time::Instant;

    static DATABASE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn idle_polling_backs_off_to_a_bounded_interval() {
        let mut poll = IDLE_POLL_MIN;
        let mut schedule = Vec::new();
        for _ in 0..6 {
            schedule.push(poll);
            poll = next_idle_poll(poll);
        }
        assert_eq!(
            schedule,
            [500, 1_000, 2_000, 4_000, 5_000, 5_000].map(Duration::from_millis)
        );
    }

    #[test]
    fn queued_mutations_wake_the_worker_after_commit() {
        let source = include_str!("tree_jobs.rs");
        let mutate = source
            .split_once("pub(crate) async fn mutate(")
            .and_then(|(_, tail)| tail.split_once("fn next_idle_poll("))
            .map(|(mutate, _)| mutate)
            .expect("mutation source should remain inspectable");
        let commit = mutate.find(".commit()").expect("mutation commits");
        let wake = mutate
            .find("WORKER_WAKE.notify_one()")
            .expect("queued jobs wake the worker");
        assert!(commit < wake, "the worker must not race an uncommitted job");
    }

    #[actix_web::test]
    async fn a_wake_sent_before_the_worker_waits_is_not_lost() {
        WORKER_WAKE.notify_one();
        tokio::time::timeout(Duration::from_millis(100), WORKER_WAKE.notified())
            .await
            .expect("notify_one stores a permit for the next wait");
    }

    fn rss_kib() -> u64 {
        std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or_default()
    }

    #[test]
    fn discovery_parent_quotas_share_one_total_row_budget() {
        for parent_count in 1..=JOB_BATCH_SIZE as usize {
            let quotas = discovery_quotas(parent_count);
            assert_eq!(quotas.len(), parent_count);
            assert_eq!(
                quotas.iter().map(|quota| i64::from(*quota)).sum::<i64>(),
                JOB_BATCH_SIZE
            );
            assert!(quotas.iter().all(|quota| *quota >= 1));
            assert!(
                quotas
                    .windows(2)
                    .all(|pair| pair[0] >= pair[1] && pair[0] - pair[1] <= 1)
            );
        }
        assert_eq!(discovery_quotas(1), vec![256]);
        assert_eq!(discovery_quotas(256), vec![1; 256]);
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL with migration 029"]
    async fn batch_mutations_apply_small_selections_and_defer_the_rest() {
        let _serial = DATABASE_TEST_LOCK.lock().await;
        let config = Config::from_env().expect("test configuration");
        let db = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
                max_size: 2,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            Metrics::new(&config),
        )
        .await
        .expect("test database");
        let owner = "usr_tree_batch";
        let ids = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        };
        let states = |values: &'static [&'static str]| {
            let db = db.clone();
            async move {
                let rows = db
                    .query(
                        "SELECT id, state FROM files WHERE id = ANY($1::text[]) ORDER BY id",
                        &[&values],
                    )
                    .await
                    .unwrap();
                rows.into_iter()
                    .map(|row| {
                        format!(
                            "{}={}",
                            row.get::<_, String>("id"),
                            row.get::<_, String>("state")
                        )
                    })
                    .collect::<Vec<_>>()
            }
        };
        db.execute(
            "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,'unused','user')",
            &[&owner],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES
            ('tb_folder',$1,'folder','tb/folder',0,'folder'),
            ('tb_big',$1,'big','tb/big',0,'folder')",
            &[&owner],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,parent_id) VALUES
            ('tb_a',$1,'a','tb/a',1,NULL),
            ('tb_b',$1,'b','tb/b',1,NULL),
            ('tb_child',$1,'child','tb/child',1,'tb_folder')",
            &[&owner],
        )
        .await
        .unwrap();
        db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,parent_id) SELECT 'tb_big_'||n,$1,'leaf-'||n,'tb/big/'||n,1,'tb_big' FROM generate_series(1,300) n", &[&owner]).await.unwrap();

        // Small roots, a selected descendant, an unknown id and a tree over the
        // synchronous budget, all in one request.
        let trash = mutate_many(
            &db,
            owner,
            &ids(&[
                "tb_child",
                "tb_folder",
                "tb_a",
                "tb_b",
                "tb_missing",
                "tb_big",
            ]),
            Action::Trash,
        )
        .await
        .unwrap();
        assert_eq!(
            trash.completed,
            ids(&["tb_child", "tb_folder", "tb_a", "tb_b"])
        );
        assert_eq!(trash.missing, ids(&["tb_missing"]));
        assert_eq!(trash.deferred, ids(&["tb_big"]));
        assert_eq!(
            states(&["tb_a", "tb_b", "tb_big", "tb_child", "tb_folder"]).await,
            [
                "tb_a=trashed",
                "tb_b=trashed",
                "tb_big=active",
                "tb_child=trashed",
                "tb_folder=trashed"
            ]
        );
        let active_big: i64 = db
            .query_one(
                "SELECT count(*) FROM files WHERE parent_id = 'tb_big' AND state = 'active'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(active_big, 300, "a deferred tree is left untouched");

        // A durable job owns the owner's tree lane; everything defers to it.
        let job = mutate(&db, owner, "tb_big", Action::Trash, None, None)
            .await
            .unwrap();
        assert!(matches!(job, MutationResult::Queued(_)));
        let blocked = mutate_many(&db, owner, &ids(&["tb_a"]), Action::Restore)
            .await
            .unwrap();
        assert_eq!(blocked.deferred, ids(&["tb_a"]));
        assert!(blocked.completed.is_empty());
        for _ in 0..32 {
            let pending: i64 = db.query_one("SELECT count(*) FROM tree_operation_jobs WHERE owner_id = $1 AND status <> 'complete'", &[&owner]).await.unwrap().get(0);
            if pending == 0 {
                break;
            }
            process_batch(&db).await.unwrap();
        }

        // Restoring a child under a trashed parent needs the per-item conflict.
        let restore = mutate_many(&db, owner, &ids(&["tb_child", "tb_a"]), Action::Restore)
            .await
            .unwrap();
        assert_eq!(restore.completed, ids(&["tb_a"]));
        assert_eq!(restore.deferred, ids(&["tb_child"]));
        assert_eq!(
            states(&["tb_a", "tb_child"]).await,
            ["tb_a=active", "tb_child=trashed"]
        );

        let delete = mutate_many(&db, owner, &ids(&["tb_folder", "tb_b"]), Action::Delete)
            .await
            .unwrap();
        assert_eq!(delete.completed, ids(&["tb_folder", "tb_b"]));
        assert!(states(&["tb_b", "tb_child", "tb_folder"]).await.is_empty());
        let queued: i64 = db.query_one("SELECT count(*) FROM storage_deletion_jobs WHERE object_key IN ('usr_tree_batch/tb/b','tb/b','usr_tree_batch/tb/child','tb/child')", &[]).await.unwrap().get(0);
        assert_eq!(queued, 2, "deleted files queue their stored objects");

        db.execute("DELETE FROM users WHERE id = $1", &[&owner])
            .await
            .unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL with migration 029"]
    async fn durable_tree_jobs_yield_between_owner_discovery_pages() {
        let _serial = DATABASE_TEST_LOCK.lock().await;
        let config = Config::from_env().expect("test configuration");
        let db = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
                max_size: 2,
                min_size: 1,
                checkout_queue_capacity: 4,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            Metrics::new(&config),
        )
        .await
        .expect("test database");
        for owner in ["usr_tree_fair_a", "usr_tree_fair_b"] {
            db.execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,'unused','user')",
                &[&owner],
            )
            .await
            .unwrap();
            db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES($1,$1,'root',$1,0,'folder')", &[&owner]).await.unwrap();
            db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,parent_id) SELECT $1||'-'||n,$1,'leaf-'||n,$1||'/'||n,1,$1 FROM generate_series(1,300) n", &[&owner]).await.unwrap();
            assert!(matches!(
                mutate(&db, owner, owner, Action::Trash, None, None)
                    .await
                    .unwrap(),
                MutationResult::Queued(_)
            ));
        }
        assert!(process_batch(&db).await.unwrap());
        assert!(process_batch(&db).await.unwrap());
        let rows=db.query("SELECT jobs.owner_id,jobs.phase,jobs.processed_nodes,count(nodes.node_id)::bigint AS discovered FROM tree_operation_jobs AS jobs JOIN tree_operation_nodes AS nodes ON nodes.job_id=jobs.id WHERE jobs.owner_id IN ('usr_tree_fair_a','usr_tree_fair_b') GROUP BY jobs.id ORDER BY jobs.owner_id", &[]).await.unwrap();
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.get::<_, String>("phase"), "discover");
            assert_eq!(row.get::<_, i64>("processed_nodes"), 0);
            assert_eq!(
                row.get::<_, i64>("discovered"),
                257,
                "each owner receives one discovery page before either receives a second"
            );
        }
        for _ in 0..24 {
            let pending:i64=db.query_one("SELECT count(*) FROM tree_operation_jobs WHERE owner_id IN ('usr_tree_fair_a','usr_tree_fair_b') AND status<>'complete'", &[]).await.unwrap().get(0);
            if pending == 0 {
                break;
            }
            assert!(process_batch(&db).await.unwrap());
        }
        let active:i64=db.query_one("SELECT count(*) FROM files WHERE owner_id IN ('usr_tree_fair_a','usr_tree_fair_b') AND state='active'", &[]).await.unwrap().get(0);
        assert_eq!(active, 0, "both queued trees complete");
        db.execute(
            "DELETE FROM users WHERE id IN ('usr_tree_fair_a','usr_tree_fair_b')",
            &[],
        )
        .await
        .unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires isolated PostgreSQL with migration 029"]
    async fn durable_tree_jobs_preserve_visibility_and_resume_between_batches() {
        let _serial = DATABASE_TEST_LOCK.lock().await;
        let config = Config::from_env().expect("test configuration");
        let db = Database::create(
            &config.database_url,
            DatabasePoolSettings {
                role: PoolRole::Maintenance,
                max_size: 4,
                min_size: 1,
                checkout_queue_capacity: 8,
                wait_timeout: Duration::from_secs(2),
                max_lifetime: Duration::from_secs(1800),
                lifetime_jitter: Duration::ZERO,
            },
            Metrics::new(&config),
        )
        .await
        .expect("test database");
        let count = std::env::var("AERALYTH_TREE_SCALE")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(10_000);
        let leaf_count = count;
        let branching = std::env::var("AERALYTH_TREE_BRANCHES")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        assert!((0..=10_000).contains(&branching));
        let count = leaf_count + branching;
        let deep_fixture = std::env::var("AERALYTH_TREE_DEEP_CHAIN").as_deref() == Ok("1");
        assert!(
            !deep_fixture || count == 150,
            "deep fixture has two 75-node chains"
        );
        let folder_fixture =
            deep_fixture || std::env::var("AERALYTH_TREE_EMPTY_FOLDERS").as_deref() == Ok("1");
        assert!(
            branching == 0 || !folder_fixture,
            "branch fixture contains files"
        );
        let kind = if folder_fixture { "folder" } else { "file" };
        let size = if folder_fixture { 0_i64 } else { 1_i64 };
        if std::env::var("AERALYTH_TREE_REUSE_FIXTURE").as_deref() != Ok("1") {
            db.execute("INSERT INTO users(id,username,password_hash,role) VALUES('usr_tree_job_test','tree-job-test','unused','user'),('usr_tree_job_control','tree-job-control','unused','user')", &[]).await.unwrap();
            db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes) VALUES('tree-job-control','usr_tree_job_control','control','tree-job-control',1)", &[]).await.unwrap();
            db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES('tree-job-root','usr_tree_job_test','root','tree-job-root',0,'folder'),('tree-job-sibling','usr_tree_job_test','sibling','tree-job-sibling',0,'folder')", &[]).await.unwrap();
            if branching > 0 {
                db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id) SELECT 'tree-job-branch-'||n,'usr_tree_job_test','branch-'||n,'tree-job/branch/'||n,0,'folder','tree-job-root' FROM generate_series(1,$1::bigint) n", &[&branching]).await.unwrap();
            }
            for first in (1..=leaf_count).step_by(1000) {
                let last = (first + 999).min(leaf_count);
                db.execute("INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,parent_id,entry_type) SELECT 'tree-job-'||n,'usr_tree_job_test','leaf-'||n,'tree-job/'||n,$4,CASE WHEN $6::bigint>0 THEN 'tree-job-branch-'||(((n-1)%$6)+1) WHEN $5 AND n=76 THEN NULL WHEN $5 AND n>1 THEN 'tree-job-'||(n-1) ELSE 'tree-job-root' END,$3 FROM generate_series($1::bigint,$2::bigint) AS n", &[&first,&last,&kind,&size,&deep_fixture,&branching]).await.unwrap();
            }
            if deep_fixture {
                db.execute(
                    "UPDATE files SET parent_id='tree-job-75' WHERE id='tree-job-76'",
                    &[],
                )
                .await
                .expect("historical move permits existing descendant depth beyond 100");
            }
        } else {
            let actual:i64=db.query_one("SELECT count(*) FROM files WHERE owner_id='usr_tree_job_test' AND id <> 'tree-job-sibling'", &[]).await.expect("recovery fixture must exist").get(0);
            assert_eq!(
                actual,
                count + 1,
                "reuse must retain the entire seeded tree"
            );
        }
        let started = Instant::now();
        let rss_before = rss_kib();
        let mut peak_rss = rss_before;
        let (navigation_stop, mut navigation_shutdown) = watch::channel(false);
        let navigation_db = db.clone();
        let navigation = tokio::spawn(async move {
            let mut samples = Vec::with_capacity(10_000);
            let mut reads = 0_usize;
            let mut max_latency = Duration::ZERO;
            loop {
                if *navigation_shutdown.borrow() {
                    break;
                }
                for owner in ["usr_tree_job_test", "usr_tree_job_control"] {
                    let start = Instant::now();
                    navigation_db.query("SELECT id FROM visible_files WHERE owner_id=$1 AND parent_id IS NULL AND state='active' ORDER BY id LIMIT 50", &[&owner]).await.expect("navigation remains available during tree jobs");
                    let latency = start.elapsed();
                    max_latency = max_latency.max(latency);
                    if samples.len() < 10_000 {
                        samples.push(latency);
                    } else {
                        samples[reads % 10_000] = latency;
                    }
                    reads += 1;
                }
                tokio::select! { _=tokio::time::sleep(Duration::from_millis(25))=>{}, _=navigation_shutdown.changed()=>{} }
            }
            samples.sort_unstable();
            let p95 = samples
                .get(samples.len() * 95 / 100)
                .copied()
                .unwrap_or_default();
            (reads, p95, max_latency)
        });
        let actions: &[Action] = if count >= 1_000_000 {
            &[Action::Trash, Action::Delete]
        } else {
            &[
                Action::Trash,
                Action::Restore,
                Action::Trash,
                Action::Delete,
            ]
        };
        for &action in actions {
            let wal_start: String = db
                .query_one("SELECT pg_current_wal_insert_lsn()::text", &[])
                .await
                .unwrap()
                .get(0);
            let job_id = match mutate(
                &db,
                "usr_tree_job_test",
                "tree-job-root",
                action,
                None,
                None,
            )
            .await
            .unwrap()
            {
                MutationResult::Queued(id) => id,
                _ => panic!("large operation must enqueue"),
            };
            let visible: i64 = db
                .query_one(
                    "SELECT count(*) FROM visible_files WHERE id IN ('tree-job-root','tree-job-1')",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(
                visible, 0,
                "both root and direct descendant access are fenced"
            );
            let before: i64 = db.query_one("SELECT total_files FROM visible_user_file_counters AS user_file_counters WHERE owner_id='usr_tree_job_test'", &[]).await.unwrap().get(0);
            // A crash before COMMIT must not advance the durable cursor.
            let mut crashed = db.get().await.unwrap();
            let interrupted = crashed.transaction().await.unwrap();
            let crashed_backend: i32 = interrupted
                .query_one("SELECT pg_backend_pid()", &[])
                .await
                .unwrap()
                .get(0);
            interrupted
                .execute(
                    "UPDATE tree_operation_jobs SET processed_nodes=999999 WHERE id=$1",
                    &[&job_id],
                )
                .await
                .unwrap();
            db.query_one("SELECT pg_terminate_backend($1)", &[&crashed_backend])
                .await
                .unwrap();
            drop(interrupted);
            drop(crashed);
            let mut batches = 0;
            let mut max_batch = Duration::ZERO;
            loop {
                let batch_start = Instant::now();
                assert!(process_batch(&db).await.unwrap());
                max_batch = max_batch.max(batch_start.elapsed());
                batches += 1;
                let row = db
                    .query_one(
                        "SELECT status,processed_nodes FROM tree_operation_jobs WHERE id=$1",
                        &[&job_id],
                    )
                    .await
                    .unwrap();
                let processed: i64 = row.get("processed_nodes");
                assert!(processed <= count + 1, "rolled-back cursor cannot leak");
                if row.get::<_, String>("status") == "complete" {
                    break;
                }
                if batches % 100 == 0 {
                    peak_rss = peak_rss.max(rss_kib());
                    eprintln!(
                        "tree {} progress: processed={processed}/{}, batches={batches}",
                        action.as_str(),
                        count + 1
                    );
                }
                if batches % 10 == 0 {
                    db.execute(
                        "UPDATE files SET favorite=NOT favorite WHERE id='tree-job-sibling'",
                        &[],
                    )
                    .await
                    .expect("sibling writes keep progressing");
                    let stable: i64 = db.query_one("SELECT total_files FROM visible_user_file_counters AS user_file_counters WHERE owner_id='usr_tree_job_test'", &[]).await.unwrap().get(0);
                    assert_eq!(
                        stable, before,
                        "counter view must not expose physical batch progress"
                    );
                }
                assert!(
                    batches
                        < if deep_fixture {
                            count as usize * 2 + 50
                        } else {
                            (count as usize / 256 + 2) * 3 + 20
                        },
                    "bounded job should make progress"
                );
            }
            let visible: i64 = db.query_one("SELECT count(*) FROM visible_files WHERE owner_id='usr_tree_job_test' AND parent_id='tree-job-root'", &[]).await.unwrap().get(0);
            assert_eq!(
                visible,
                if matches!(action, Action::Delete) {
                    0
                } else if branching > 0 {
                    branching
                } else if deep_fixture {
                    1
                } else {
                    count
                }
            );
            let wal_bytes: i64 = db
                .query_one(
                    "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::text::pg_lsn)::bigint",
                    &[&wal_start],
                )
                .await
                .unwrap()
                .get(0);
            let dead_tuples: i64 = db
                .query_one(
                    "SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='files'",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            eprintln!(
                "durable tree {}: nodes={}, batches={}, max_batch={max_batch:?}, wal_bytes={wal_bytes}, files_dead_tuples={dead_tuples}",
                action.as_str(),
                count + 1,
                batches
            );
        }
        navigation_stop.send(true).unwrap();
        let (reads, p95, max_navigation) = navigation.await.unwrap();
        eprintln!(
            "tree navigation same+other owner: reads={reads}, p95={p95:?}, max={max_navigation:?}, rss_before_kib={rss_before}, peak_rss_kib={peak_rss}"
        );
        let queued: i64 = db.query_one("SELECT count(*) FROM storage_deletion_jobs WHERE object_key LIKE 'usr_tree_job_test/tree-job/%' OR object_key LIKE 'tree-job/%'", &[]).await.unwrap().get(0);
        assert_eq!(
            queued,
            if folder_fixture { 0 } else { leaf_count },
            "every deleted object has a durable cleanup job"
        );
        db.execute(
            "DELETE FROM users WHERE id IN ('usr_tree_job_test','usr_tree_job_control')",
            &[],
        )
        .await
        .unwrap();
        db.execute("DELETE FROM storage_deletion_jobs WHERE object_key LIKE 'usr_tree_job_test/tree-job/%' OR object_key LIKE 'tree-job/%'", &[]).await.unwrap();
        eprintln!("durable tree full lifecycle: {:?}", started.elapsed());
    }
}
