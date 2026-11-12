//! Set-based reservation and publication for the small files of one inline
//! upload request.
//!
//! The per-file path costs a transaction, an owner-wide lock and some thirty
//! statements per file. Here the files of one reservation window share one
//! reservation transaction and one publication transaction whose statements
//! each cover every file. Every file is first checked, under the same row
//! locks, against the conditions the per-file path enforces. A file the batch
//! cannot vouch for (a resumed or competing upload, a migration, share
//! wrappers, a moved head, a fenced share, a failing write) takes the per-file
//! path instead, which owns its exact outcome.

use std::collections::{HashMap, HashSet};

use actix_web::{Result, error};

use super::super::upload_reservations::{PendingUsage, reservation_amount};
use super::{
    DecodedNodeRecord, PublishResponse, VaultUpload, VaultUploadInitRequest, decode_fixed,
    encode_bytes, lock_share_topology, publish_record_in_transaction, requested_parent_id,
    validate_ciphertext_shape, validate_head_cas, validate_node_id, validate_owner_wrappers,
    validate_record_for_upload, vault_object_key,
};
use crate::auth::SessionPrincipal;
use crate::collection_timestamps::touch_ancestor_collection_set;
use crate::db::{execute_cached, query_cached, query_opt_cached};
use crate::e2ee::uses_vault_multipart_upload;
use crate::state::AppState;
use crate::storage::ObjectMetadata;

pub(super) struct InlineStageRequest<'a> {
    pub init: &'a VaultUploadInitRequest,
    pub decoded: &'a DecodedNodeRecord,
    pub checksum_sha256: &'a str,
}

pub(super) enum InlineStageOutcome {
    /// Reserved and bound to its checksum, ready for its storage write.
    Staged(Box<VaultUpload>),
    /// The owner's ledger refused the reservation with this error.
    Refused(actix_web::Error),
    /// The per-file path decides this file.
    Individually,
}

/// Reserves the files of one window together. The reservation of each file is
/// admitted in request order against the owner's locked ledger, exactly as
/// consecutive per-file reservations would be.
pub(super) async fn stage_inline_batch(
    state: &AppState,
    user: &SessionPrincipal,
    requests: &[InlineStageRequest<'_>],
) -> Vec<InlineStageOutcome> {
    let mut outcomes = requests
        .iter()
        .map(|_| InlineStageOutcome::Individually)
        .collect::<Vec<_>>();
    let mut planned = Vec::with_capacity(requests.len());
    let mut node_ids = HashSet::with_capacity(requests.len());
    for (index, request) in requests.iter().enumerate() {
        // A repeated node resumes or competes with the first one; that is the
        // per-file path's decision.
        if let Some(upload) = planned_inline_upload(user, request)
            && node_ids.insert(upload.node_id.clone())
        {
            planned.push((index, upload));
        }
    }
    if planned.is_empty() {
        return outcomes;
    }
    match reserve_planned_uploads(state, user, planned).await {
        Ok(reserved) => {
            for (index, outcome) in reserved {
                outcomes[index] = outcome;
            }
        }
        Err(failure) => {
            log::warn!("inline reservation batch fell back to per-file staging: {failure}");
        }
    }
    state.db.release_request_connection().await;
    outcomes
}

/// The upload row the per-file path would stage for a new single-object
/// generation, or `None` when that path must judge the request itself.
fn planned_inline_upload(
    user: &SessionPrincipal,
    request: &InlineStageRequest<'_>,
) -> Option<VaultUpload> {
    let init = request.init;
    if init.entry_type != "file" || init.migration {
        return None;
    }
    validate_node_id(&init.node_id).ok()?;
    let generation_id = decode_fixed::<16>(&init.generation_id, "generation id")
        .ok()?
        .to_vec();
    let generation_number = i64::try_from(init.generation_number)
        .ok()
        .filter(|value| *value > 0)?;
    let ciphertext_length = i64::try_from(init.ciphertext_length).ok()?;
    let chunk_count = i32::try_from(init.chunk_count).ok()?;
    validate_ciphertext_shape(
        &init.entry_type,
        init.ciphertext_length,
        u64::from(init.chunk_count),
    )
    .ok()?;
    if uses_vault_multipart_upload(init.ciphertext_length) {
        return None;
    }
    let parent_id = requested_parent_id(init.parent_id.as_deref())
        .ok()?
        .map(str::to_owned);
    let upload = VaultUpload {
        id: format!("vup_{}", super::random_id().ok()?),
        node_id: init.node_id.clone(),
        parent_id,
        entry_type: init.entry_type.clone(),
        generation_number,
        generation_id,
        object_key: Some(vault_object_key(&user.id, &init.node_id).ok()?),
        ciphertext_length,
        chunk_count,
        mode: "single".to_owned(),
        part_size_bytes: None,
        multipart_upload_id: None,
        status: "pending".to_owned(),
        checksum_sha256: Some(request.checksum_sha256.to_owned()),
    };
    validate_record_for_upload(request.decoded, &upload).ok()?;
    Some(upload)
}

async fn reserve_planned_uploads(
    state: &AppState,
    user: &SessionPrincipal,
    planned: Vec<(usize, VaultUpload)>,
) -> Result<Vec<(usize, InlineStageOutcome)>> {
    let node_ids = planned
        .iter()
        .map(|(_, upload)| upload.node_id.clone())
        .collect::<Vec<_>>();
    // The per-file path takes these locks one at a time. Taking them in key
    // order keeps two batches of one owner from waiting on each other.
    let mut lock_keys = node_ids
        .iter()
        .map(|node_id| format!("vault-upload:{}:{node_id}", user.id))
        .collect::<Vec<_>>();
    lock_keys.sort();
    let parent_ids = planned
        .iter()
        .filter_map(|(_, upload)| upload.parent_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    query_cached(
        &transaction,
        "
            SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
            FROM unnest($1::text[]) AS keys(lock_key)
        ",
        &[&lock_keys],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    let valid_parents = query_cached(
        &transaction,
        "
            SELECT id FROM visible_files AS files
            WHERE id = ANY($1::text[]) AND owner_id = $2 AND entry_type = 'folder'
              AND state = 'active' AND e2ee_state = 'encrypted'
        ",
        &[&parent_ids, &user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| row.get::<_, String>("id"))
    .collect::<HashSet<_>>();
    let existing_nodes = query_cached(
        &transaction,
        "
            SELECT id, entry_type, size_bytes
            FROM visible_files AS files
            WHERE id = ANY($1::text[]) AND owner_id = $2 AND state = 'active'
            ORDER BY id
            FOR UPDATE
        ",
        &[&node_ids, &user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| {
        (
            row.get::<_, String>("id"),
            (
                row.get::<_, String>("entry_type"),
                row.get::<_, i64>("size_bytes"),
            ),
        )
    })
    .collect::<HashMap<_, _>>();
    let uploading = query_cached(
        &transaction,
        "
            SELECT DISTINCT node_id FROM vault_uploads
            WHERE owner_id = $1 AND node_id = ANY($2::text[])
              AND status IN ('initializing', 'pending', 'completing', 'aborting')
        ",
        &[&user.id, &node_ids],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| row.get::<_, String>("node_id"))
    .collect::<HashSet<_>>();
    let Some(usage) = query_opt_cached(
        &transaction,
        "
            SELECT used_bytes, reserved_bytes, pending_uploads
            FROM user_storage_usage
            WHERE owner_id = $1
            FOR UPDATE
        ",
        &[&user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    else {
        return Err(error::ErrorInternalServerError(
            "storage usage ledger is missing",
        ));
    };
    let mut usage = PendingUsage {
        used_bytes: usage.get("used_bytes"),
        reserved_bytes: usage.get("reserved_bytes"),
        pending_uploads: usage.get("pending_uploads"),
    };
    let ledger = usage;

    let mut outcomes = Vec::with_capacity(planned.len());
    let mut reserved = Vec::with_capacity(planned.len());
    let mut reservation_bytes = Vec::with_capacity(planned.len());
    for (index, upload) in planned {
        let existing = existing_nodes.get(&upload.node_id);
        // A pending generation is resumed, and any other one conflicts; an
        // invalid parent or a folder in the way is refused.
        if uploading.contains(&upload.node_id)
            || upload
                .parent_id
                .as_ref()
                .is_some_and(|parent_id| !valid_parents.contains(parent_id))
            || existing.is_some_and(|(entry_type, _)| *entry_type != upload.entry_type)
        {
            continue;
        }
        let replacement_credit = existing.map_or(0, |(_, size_bytes)| *size_bytes);
        let Ok(amount) = reservation_amount(upload.ciphertext_length, replacement_credit) else {
            continue;
        };
        match usage.reserve(amount, state.config.storage_quota_bytes) {
            Ok(()) => {
                reservation_bytes.push(amount.ledger_bytes);
                reserved.push((index, upload));
            }
            Err(refusal) => outcomes.push((index, InlineStageOutcome::Refused(refusal))),
        }
    }

    if !reserved.is_empty() {
        execute_cached(
            &transaction,
            "
                UPDATE user_storage_usage
                SET reserved_bytes = reserved_bytes + $2::bigint,
                    pending_uploads = pending_uploads + $3::bigint,
                    updated_at = now()
                WHERE owner_id = $1
            ",
            &[
                &user.id,
                &(usage.reserved_bytes - ledger.reserved_bytes),
                &(usage.pending_uploads - ledger.pending_uploads),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
        let mut ids = Vec::with_capacity(reserved.len());
        let mut upload_node_ids = Vec::with_capacity(reserved.len());
        let mut upload_parent_ids = Vec::with_capacity(reserved.len());
        let mut generation_numbers = Vec::with_capacity(reserved.len());
        let mut generation_ids = Vec::with_capacity(reserved.len());
        let mut object_keys = Vec::with_capacity(reserved.len());
        let mut ciphertext_lengths = Vec::with_capacity(reserved.len());
        let mut chunk_counts = Vec::with_capacity(reserved.len());
        let mut checksums = Vec::with_capacity(reserved.len());
        for (_, upload) in &reserved {
            ids.push(upload.id.as_str());
            upload_node_ids.push(upload.node_id.as_str());
            upload_parent_ids.push(upload.parent_id.as_deref());
            generation_numbers.push(upload.generation_number);
            generation_ids.push(upload.generation_id.as_slice());
            object_keys.push(upload.object_key.as_deref());
            ciphertext_lengths.push(upload.ciphertext_length);
            chunk_counts.push(upload.chunk_count);
            checksums.push(upload.checksum_sha256.as_deref());
        }
        // The rows land as the per-file path leaves them once storage is
        // prepared and the checksum is bound: pending, with an open write
        // lease. A single-object upload prepares no storage state.
        execute_cached(
            &transaction,
            "
                INSERT INTO vault_uploads (
                  id, node_id, owner_id, parent_id, entry_type,
                  generation_number, generation_id, object_key,
                  ciphertext_length, chunk_count, upload_mode,
                  part_size_bytes, reservation_bytes, status,
                  checksum_sha256, write_expires_at, expires_at
                )
                SELECT batch.id, batch.node_id, $11, batch.parent_id, 'file',
                       batch.generation_number, batch.generation_id,
                       batch.object_key, batch.ciphertext_length,
                       batch.chunk_count, 'single', NULL,
                       batch.reservation_bytes, 'pending',
                       batch.checksum_sha256,
                       now() + interval '1 hour', now() + interval '1 hour'
                FROM unnest(
                  $1::text[], $2::text[], $3::text[], $4::bigint[],
                  $5::bytea[], $6::text[], $7::bigint[], $8::integer[],
                  $9::bigint[], $10::text[]
                ) AS batch(
                  id, node_id, parent_id, generation_number, generation_id,
                  object_key, ciphertext_length, chunk_count,
                  reservation_bytes, checksum_sha256
                )
            ",
            &[
                &ids,
                &upload_node_ids,
                &upload_parent_ids,
                &generation_numbers,
                &generation_ids,
                &object_keys,
                &ciphertext_lengths,
                &chunk_counts,
                &reservation_bytes,
                &checksums,
                &user.id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);

    outcomes.extend(
        reserved
            .into_iter()
            .map(|(index, upload)| (index, InlineStageOutcome::Staged(Box::new(upload)))),
    );
    Ok(outcomes)
}

pub(super) struct InlinePublication<'a> {
    pub upload: &'a VaultUpload,
    pub decoded: &'a DecodedNodeRecord,
    pub metadata: &'a ObjectMetadata,
}

/// Publishes stored files in one transaction under one share-topology lock,
/// with one outcome per file in request order. A file failing its checks
/// fails alone, with the error the per-file path reports.
pub(super) async fn publish_inline_batch(
    state: &AppState,
    user: &SessionPrincipal,
    publications: &[InlinePublication<'_>],
) -> Result<Vec<Result<PublishResponse>>> {
    let mut outcomes = publications.iter().map(|_| None).collect::<Vec<_>>();
    let mut node_ids = HashSet::with_capacity(publications.len());
    let mut upload_ids = HashSet::with_capacity(publications.len());
    let mut individual = Vec::new();
    let mut candidates = Vec::with_capacity(publications.len());
    for (index, publication) in publications.iter().enumerate() {
        if is_batch_candidate(publication)
            && node_ids.insert(publication.upload.node_id.as_str())
            && upload_ids.insert(publication.upload.id.as_str())
        {
            candidates.push(index);
        } else {
            individual.push(index);
        }
    }

    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
    let mut transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    if !candidates.is_empty() {
        let savepoint = transaction
            .transaction()
            .await
            .map_err(error::ErrorInternalServerError)?;
        match publish_batch(&savepoint, user, publications, &candidates).await {
            Ok(published) => {
                savepoint
                    .commit()
                    .await
                    .map_err(error::ErrorInternalServerError)?;
                for (index, response) in published {
                    outcomes[index] = Some(Ok(response));
                }
            }
            Err(failure) => {
                savepoint
                    .rollback()
                    .await
                    .map_err(error::ErrorInternalServerError)?;
                log::warn!("inline publication batch fell back to per-file publication: {failure}");
            }
        }
    }
    individual.extend(
        candidates
            .into_iter()
            .filter(|index| outcomes[*index].is_none()),
    );
    individual.sort_unstable();
    for index in individual {
        let publication = &publications[index];
        let savepoint = transaction
            .transaction()
            .await
            .map_err(error::ErrorInternalServerError)?;
        let published = publish_record_in_transaction(
            &savepoint,
            user,
            publication.upload,
            publication.decoded,
            Some(publication.metadata),
        )
        .await;
        let finished = if published.is_ok() {
            savepoint.commit().await
        } else {
            savepoint.rollback().await
        };
        finished.map_err(error::ErrorInternalServerError)?;
        outcomes[index] = Some(published);
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(outcomes
        .into_iter()
        .map(|outcome| {
            outcome
                .unwrap_or_else(|| Err(error::ErrorInternalServerError("file was not published")))
        })
        .collect())
}

/// The shapes the set-based statements write. Inline share wrappers and
/// anything else take the per-file path.
fn is_batch_candidate(publication: &InlinePublication<'_>) -> bool {
    let InlinePublication {
        upload, decoded, ..
    } = publication;
    let bootstrap = &decoded.verified.bootstrap;
    upload.entry_type == "file"
        && upload.mode == "single"
        && upload.object_key.is_some()
        && bootstrap.node_id == upload.node_id
        && i64::try_from(bootstrap.record_version).is_ok()
        && i64::try_from(bootstrap.signer_key_version).is_ok()
        && decoded.wrappers.iter().all(|wrapper| {
            matches!(wrapper.record.kind, 1 | 2)
                && i64::try_from(wrapper.record.record_version).is_ok()
        })
        && validate_owner_wrappers(decoded, upload.parent_id.as_deref()).is_ok()
}

struct LockedNode {
    owner_id: String,
    parent_id: Option<String>,
    entry_type: String,
    e2ee_state: Option<String>,
    current_generation_number: Option<i64>,
    storage_name: String,
}

/// Checks every candidate under the row locks the per-file path takes and
/// writes the ones that pass with one statement per table. Candidates that
/// fail are left for the per-file path.
async fn publish_batch(
    transaction: &deadpool_postgres::Transaction<'_>,
    user: &SessionPrincipal,
    publications: &[InlinePublication<'_>],
    candidates: &[usize],
) -> Result<Vec<(usize, PublishResponse)>> {
    let upload_ids = candidates
        .iter()
        .map(|index| publications[*index].upload.id.as_str())
        .collect::<Vec<_>>();
    let node_ids = candidates
        .iter()
        .map(|index| publications[*index].upload.node_id.as_str())
        .collect::<Vec<_>>();
    let upload_statuses = query_cached(
        transaction,
        "
            SELECT id, status FROM vault_uploads
            WHERE id = ANY($1::text[]) AND owner_id = $2
            ORDER BY id
            FOR UPDATE
        ",
        &[&upload_ids, &user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| (row.get::<_, String>("id"), row.get::<_, String>("status")))
    .collect::<HashMap<_, _>>();
    let nodes = query_cached(
        transaction,
        "
            SELECT id, owner_id, parent_id, entry_type, e2ee_state,
                   current_generation_number, storage_name
            FROM visible_files AS files
            WHERE id = ANY($1::text[])
            ORDER BY id
            FOR UPDATE
        ",
        &[&node_ids],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| {
        (
            row.get::<_, String>("id"),
            LockedNode {
                owner_id: row.get("owner_id"),
                parent_id: row.get("parent_id"),
                entry_type: row.get("entry_type"),
                e2ee_state: row.get("e2ee_state"),
                current_generation_number: row.get("current_generation_number"),
                storage_name: row.get("storage_name"),
            },
        )
    })
    .collect::<HashMap<_, _>>();
    let heads = query_cached(
        transaction,
        "
            SELECT node_id, record_version, record_hash
            FROM vault_node_heads
            WHERE node_id = ANY($1::text[])
            ORDER BY node_id
            FOR UPDATE
        ",
        &[&node_ids],
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    .into_iter()
    .map(|row| {
        (
            row.get::<_, String>("node_id"),
            (
                row.get::<_, i64>("record_version"),
                row.get::<_, Vec<u8>>("record_hash"),
            ),
        )
    })
    .collect::<HashMap<_, _>>();
    // A published node anchors its own share checks; a new one its parent's.
    let anchor = |index: usize| {
        let upload = publications[index].upload;
        if nodes.contains_key(&upload.node_id) {
            Some(upload.node_id.as_str())
        } else {
            upload.parent_id.as_deref()
        }
    };
    let anchors = candidates
        .iter()
        .filter_map(|index| anchor(*index))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let share_states = if anchors.is_empty() {
        HashMap::new()
    } else {
        query_cached(
            transaction,
            "
                WITH RECURSIVE ancestors AS (
                  SELECT files.id AS anchor_id, files.id, files.parent_id,
                         ARRAY[files.id]::text[] AS visited_ids, 0::integer AS depth
                  FROM visible_files AS files
                  WHERE files.id = ANY($1::text[]) AND files.owner_id = $2
                  UNION ALL
                  SELECT child.anchor_id, parent.id, parent.parent_id,
                         child.visited_ids || parent.id, child.depth + 1
                  FROM visible_files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2
                    AND child.depth < 100
                    AND NOT parent.id = ANY(child.visited_ids)
                )
                SELECT ancestors.anchor_id,
                       COALESCE(bool_or(
                         shares.status = 'rotating' OR shares.publication_fenced
                       ), FALSE) AS blocked,
                       COALESCE(bool_or(
                         shares.status = 'active' AND shares.publication_fenced = FALSE
                       ), FALSE) AS share_sync_required
                FROM ancestors
                LEFT JOIN vault_shares AS shares
                  ON shares.root_node_id = ancestors.id AND shares.owner_id = $2
                GROUP BY ancestors.anchor_id
            ",
            &[&anchors, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("anchor_id"),
                (
                    row.get::<_, bool>("blocked"),
                    row.get::<_, bool>("share_sync_required"),
                ),
            )
        })
        .collect::<HashMap<_, _>>()
    };

    // The conditions publish_record_in_transaction enforces, in the order it
    // checks them, for the shapes is_batch_candidate admits.
    let mut verified = Vec::with_capacity(candidates.len());
    for &index in candidates {
        let InlinePublication {
            upload, decoded, ..
        } = publications[index];
        let bootstrap = &decoded.verified.bootstrap;
        if !matches!(
            upload_statuses.get(&upload.id).map(String::as_str),
            Some("pending" | "completing")
        ) {
            continue;
        }
        let existing = nodes.get(&upload.node_id);
        let node_matches = match existing {
            Some(node) => {
                node.owner_id == user.id
                    && node.entry_type == upload.entry_type
                    && node.parent_id == upload.parent_id
                    && node.e2ee_state.as_deref() == Some("encrypted")
            }
            None => upload.generation_number == 1 && bootstrap.record_version == 1,
        };
        let head_matches = match heads.get(&upload.node_id) {
            Some((record_version, record_hash)) => {
                validate_head_cas(*record_version, record_hash, bootstrap).is_ok()
            }
            None => bootstrap.record_version == 1 && bootstrap.previous_record_hash.is_none(),
        };
        let generation_matches = existing.is_none_or(|node| {
            node.current_generation_number.map(|value| value + 1) == Some(upload.generation_number)
        });
        let (blocked, share_sync_required) = anchor(index)
            .and_then(|anchor| share_states.get(anchor))
            .copied()
            .unwrap_or((false, false));
        if node_matches && head_matches && generation_matches && !blocked {
            verified.push((index, existing, share_sync_required));
        }
    }
    if verified.is_empty() {
        return Ok(Vec::new());
    }

    let mut inserted = FileColumns::default();
    let mut replaced = FileColumns::default();
    let mut superseded_node_ids = Vec::new();
    let mut superseded_objects = Vec::new();
    let mut records = RecordColumns::default();
    let mut wrappers = WrapperColumns::default();
    let mut synced_node_ids = Vec::new();
    let mut synced_versions = Vec::new();
    let mut unsynced_node_ids = Vec::new();
    let mut touched_parent_ids = Vec::new();
    let mut published_upload_ids = Vec::with_capacity(verified.len());
    let mut responses = Vec::with_capacity(verified.len());
    for &(index, existing, share_sync_required) in &verified {
        let InlinePublication {
            upload,
            decoded,
            metadata,
        } = publications[index];
        let bootstrap = &decoded.verified.bootstrap;
        let record_version = i64::try_from(bootstrap.record_version)
            .map_err(|_| error::ErrorBadRequest("record version is invalid"))?;
        let storage_name = upload
            .object_key
            .clone()
            .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
        match existing {
            None => inserted.push(upload, metadata, storage_name.clone()),
            Some(node) => {
                if node.storage_name != storage_name {
                    superseded_node_ids.push(upload.node_id.as_str());
                    superseded_objects.push(node.storage_name.as_str());
                }
                replaced.push(upload, metadata, storage_name.clone());
            }
        }
        records.push(upload, decoded, record_version)?;
        if share_sync_required {
            synced_node_ids.push(upload.node_id.as_str());
            synced_versions.push(record_version);
        } else {
            unsynced_node_ids.push(upload.node_id.as_str());
        }
        wrappers.push(decoded)?;
        if let Some(parent_id) = &upload.parent_id {
            touched_parent_ids.push(parent_id.clone());
        }
        published_upload_ids.push(upload.id.as_str());
        responses.push((
            index,
            PublishResponse {
                node_id: upload.node_id.clone(),
                generation_number: upload.generation_number,
                generation_id: encode_bytes(&upload.generation_id),
                record_version,
                record_hash: encode_bytes(decoded.verified.record_hash),
                share_sync_required,
            },
        ));
    }

    // The statements and their order are those of publish_record_in_transaction.
    if !inserted.ids.is_empty() {
        execute_cached(
            transaction,
            "
                INSERT INTO files (
                  id, owner_id, original_name, storage_name, mime_type,
                  size_bytes, entry_type, parent_id, checksum_sha256,
                  object_etag, e2ee_state, current_generation_number,
                  current_generation_id
                )
                SELECT batch.id, $10, batch.original_name, batch.storage_name,
                       'application/octet-stream', batch.size_bytes, 'file',
                       batch.parent_id, batch.checksum_sha256, batch.object_etag,
                       'encrypted', batch.generation_number, batch.generation_id
                FROM unnest(
                  $1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[],
                  $6::text[], $7::text[], $8::bigint[], $9::bytea[]
                ) AS batch(
                  id, original_name, storage_name, size_bytes, parent_id,
                  checksum_sha256, object_etag, generation_number, generation_id
                )
            ",
            &[
                &inserted.ids,
                &inserted.original_names,
                &inserted.storage_names,
                &inserted.size_bytes,
                &inserted.parent_ids,
                &inserted.checksums,
                &inserted.etags,
                &inserted.generation_numbers,
                &inserted.generation_ids,
                &user.id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    if !replaced.ids.is_empty() {
        execute_cached(
            transaction,
            "
                UPDATE files
                SET original_name = batch.original_name,
                    storage_name = batch.storage_name,
                    mime_type = 'application/octet-stream',
                    size_bytes = batch.size_bytes,
                    checksum_sha256 = batch.checksum_sha256,
                    object_etag = batch.object_etag,
                    e2ee_state = 'encrypted',
                    current_generation_number = batch.generation_number,
                    current_generation_id = batch.generation_id,
                    updated_at = now()
                FROM unnest(
                  $1::text[], $2::text[], $3::text[], $4::bigint[],
                  $5::text[], $6::text[], $7::bigint[], $8::bytea[]
                ) AS batch(
                  id, original_name, storage_name, size_bytes,
                  checksum_sha256, object_etag, generation_number, generation_id
                )
                WHERE files.id = batch.id AND files.owner_id = $9
            ",
            &[
                &replaced.ids,
                &replaced.original_names,
                &replaced.storage_names,
                &replaced.size_bytes,
                &replaced.checksums,
                &replaced.etags,
                &replaced.generation_numbers,
                &replaced.generation_ids,
                &user.id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    if !superseded_node_ids.is_empty() {
        execute_cached(
            transaction,
            "
                UPDATE vault_object_generations
                SET status = 'retired', retired_at = now()
                WHERE node_id = ANY($1::text[]) AND status = 'published'
            ",
            &[&superseded_node_ids],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
        execute_cached(
            transaction,
            "
                INSERT INTO storage_deletion_jobs (object_key)
                SELECT unnest($1::text[])
                ON CONFLICT (object_key) DO NOTHING
            ",
            &[&superseded_objects],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    execute_cached(
        transaction,
        "
            INSERT INTO vault_node_records (
              node_id, owner_id, record_version, record_hash,
              previous_record_hash, bootstrap_cbor, bootstrap_signature,
              encrypted_manifest, manifest_hash, signer_key_version
            )
            SELECT batch.node_id, $10, batch.record_version, batch.record_hash,
                   batch.previous_record_hash, batch.bootstrap_cbor,
                   batch.bootstrap_signature, batch.encrypted_manifest,
                   batch.manifest_hash, batch.signer_key_version
            FROM unnest(
              $1::text[], $2::bigint[], $3::bytea[], $4::bytea[], $5::bytea[],
              $6::bytea[], $7::bytea[], $8::bytea[], $9::bigint[]
            ) AS batch(
              node_id, record_version, record_hash, previous_record_hash,
              bootstrap_cbor, bootstrap_signature, encrypted_manifest,
              manifest_hash, signer_key_version
            )
        ",
        &[
            &records.node_ids,
            &records.record_versions,
            &records.record_hashes,
            &records.previous_record_hashes,
            &records.bootstrap_cbors,
            &records.signatures,
            &records.encrypted_manifests,
            &records.manifest_hashes,
            &records.signer_key_versions,
            &user.id,
        ],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if !synced_node_ids.is_empty() {
        execute_cached(
            transaction,
            "
                INSERT INTO vault_share_sync_jobs (node_id, owner_id, record_version)
                SELECT batch.node_id, $3, batch.record_version
                FROM unnest($1::text[], $2::bigint[]) AS batch(node_id, record_version)
                ON CONFLICT (node_id) DO UPDATE SET
                  owner_id = EXCLUDED.owner_id,
                  record_version = EXCLUDED.record_version,
                  attempts = 0,
                  last_error = NULL,
                  updated_at = now()
            ",
            &[&synced_node_ids, &synced_versions, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    if !unsynced_node_ids.is_empty() {
        execute_cached(
            transaction,
            "
                DELETE FROM vault_share_sync_jobs
                WHERE node_id = ANY($1::text[]) AND owner_id = $2
            ",
            &[&unsynced_node_ids, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    }
    execute_cached(
        transaction,
        "
            INSERT INTO vault_wrappers (
              wrapper_id, owner_id, node_id, parent_node_id,
              wrapper_kind, record_version, canonical_cbor, wrapper_hash
            )
            SELECT batch.wrapper_id, $8, batch.node_id, batch.parent_node_id,
                   batch.wrapper_kind, batch.record_version,
                   batch.canonical_cbor, batch.wrapper_hash
            FROM unnest(
              $1::bytea[], $2::text[], $3::text[], $4::text[],
              $5::bigint[], $6::bytea[], $7::bytea[]
            ) AS batch(
              wrapper_id, node_id, parent_node_id, wrapper_kind,
              record_version, canonical_cbor, wrapper_hash
            )
        ",
        &[
            &wrappers.wrapper_ids,
            &wrappers.node_ids,
            &wrappers.parent_node_ids,
            &wrappers.kinds,
            &wrappers.record_versions,
            &wrappers.canonical_cbors,
            &wrappers.hashes,
            &user.id,
        ],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    execute_cached(
        transaction,
        "
            INSERT INTO vault_node_heads (node_id, owner_id, record_version, record_hash)
            SELECT batch.node_id, $4, batch.record_version, batch.record_hash
            FROM unnest($1::text[], $2::bigint[], $3::bytea[])
              AS batch(node_id, record_version, record_hash)
            ON CONFLICT (node_id) DO UPDATE SET
              record_version = EXCLUDED.record_version,
              record_hash = EXCLUDED.record_hash,
              updated_at = now()
        ",
        &[
            &records.node_ids,
            &records.record_versions,
            &records.record_hashes,
            &user.id,
        ],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    execute_cached(
        transaction,
        "
            INSERT INTO vault_object_generations (
              node_id, owner_id, generation_number, generation_id,
              object_key, ciphertext_length, chunk_count,
              ciphertext_merkle_root, status
            )
            SELECT batch.node_id, $8, batch.generation_number, batch.generation_id,
                   batch.object_key, batch.ciphertext_length, batch.chunk_count,
                   batch.ciphertext_merkle_root, 'published'
            FROM unnest(
              $1::text[], $2::bigint[], $3::bytea[], $4::text[],
              $5::bigint[], $6::integer[], $7::bytea[]
            ) AS batch(
              node_id, generation_number, generation_id, object_key,
              ciphertext_length, chunk_count, ciphertext_merkle_root
            )
        ",
        &[
            &records.node_ids,
            &records.generation_numbers,
            &records.generation_ids,
            &records.object_keys,
            &records.ciphertext_lengths,
            &records.chunk_counts,
            &records.ciphertext_merkle_roots,
            &user.id,
        ],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    touch_ancestor_collection_set(transaction, &touched_parent_ids, &user.id)
        .await
        .map_err(error::ErrorInternalServerError)?;
    let published = execute_cached(
        transaction,
        "
            UPDATE vault_uploads
            SET status = 'published', published_at = now()
            WHERE id = ANY($1::text[]) AND owner_id = $2
              AND status IN ('pending', 'completing')
        ",
        &[&published_upload_ids, &user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if published != published_upload_ids.len() as u64 {
        return Err(error::ErrorConflict("upload state changed; retry"));
    }
    Ok(responses)
}

/// The encrypted placeholder name a published node carries.
fn encrypted_name(node_id: &str) -> String {
    format!(
        "encrypted-{}",
        node_id.chars().rev().take(8).collect::<String>()
    )
}

#[derive(Default)]
struct FileColumns<'a> {
    ids: Vec<&'a str>,
    original_names: Vec<String>,
    storage_names: Vec<String>,
    size_bytes: Vec<i64>,
    parent_ids: Vec<Option<&'a str>>,
    checksums: Vec<Option<&'a str>>,
    etags: Vec<Option<&'a str>>,
    generation_numbers: Vec<i64>,
    generation_ids: Vec<&'a [u8]>,
}

impl<'a> FileColumns<'a> {
    fn push(
        &mut self,
        upload: &'a VaultUpload,
        metadata: &'a ObjectMetadata,
        storage_name: String,
    ) {
        self.ids.push(&upload.node_id);
        self.original_names.push(encrypted_name(&upload.node_id));
        self.storage_names.push(storage_name);
        self.size_bytes.push(upload.ciphertext_length);
        self.parent_ids.push(upload.parent_id.as_deref());
        self.checksums.push(metadata.checksum_sha256.as_deref());
        self.etags.push(metadata.etag.as_deref());
        self.generation_numbers.push(upload.generation_number);
        self.generation_ids.push(&upload.generation_id);
    }
}

#[derive(Default)]
struct RecordColumns<'a> {
    node_ids: Vec<&'a str>,
    record_versions: Vec<i64>,
    record_hashes: Vec<&'a [u8]>,
    previous_record_hashes: Vec<Option<&'a [u8]>>,
    bootstrap_cbors: Vec<&'a [u8]>,
    signatures: Vec<&'a [u8]>,
    encrypted_manifests: Vec<&'a [u8]>,
    manifest_hashes: Vec<&'a [u8]>,
    signer_key_versions: Vec<i64>,
    generation_numbers: Vec<i64>,
    generation_ids: Vec<&'a [u8]>,
    object_keys: Vec<Option<&'a str>>,
    ciphertext_lengths: Vec<i64>,
    chunk_counts: Vec<i32>,
    ciphertext_merkle_roots: Vec<&'a [u8]>,
}

impl<'a> RecordColumns<'a> {
    fn push(
        &mut self,
        upload: &'a VaultUpload,
        decoded: &'a DecodedNodeRecord,
        record_version: i64,
    ) -> Result<()> {
        let bootstrap = &decoded.verified.bootstrap;
        self.node_ids.push(&upload.node_id);
        self.record_versions.push(record_version);
        self.record_hashes.push(&decoded.verified.record_hash);
        self.previous_record_hashes.push(
            bootstrap
                .previous_record_hash
                .as_ref()
                .map(|value| value.as_slice()),
        );
        self.bootstrap_cbors.push(&decoded.bootstrap_cbor);
        self.signatures.push(&decoded.signature);
        self.encrypted_manifests.push(&decoded.encrypted_manifest);
        self.manifest_hashes.push(&bootstrap.manifest_hash);
        self.signer_key_versions.push(
            i64::try_from(bootstrap.signer_key_version)
                .map_err(|_| error::ErrorBadRequest("signer key version is invalid"))?,
        );
        self.generation_numbers.push(upload.generation_number);
        self.generation_ids.push(&upload.generation_id);
        self.object_keys.push(upload.object_key.as_deref());
        self.ciphertext_lengths.push(upload.ciphertext_length);
        self.chunk_counts.push(upload.chunk_count);
        self.ciphertext_merkle_roots
            .push(&bootstrap.ciphertext_merkle_root);
        Ok(())
    }
}

#[derive(Default)]
struct WrapperColumns<'a> {
    wrapper_ids: Vec<&'a [u8]>,
    node_ids: Vec<&'a str>,
    parent_node_ids: Vec<Option<&'a str>>,
    kinds: Vec<&'static str>,
    record_versions: Vec<i64>,
    canonical_cbors: Vec<&'a [u8]>,
    hashes: Vec<&'a [u8]>,
}

impl<'a> WrapperColumns<'a> {
    /// The owner wrappers replace_owner_wrappers writes for one record.
    fn push(&mut self, decoded: &'a DecodedNodeRecord) -> Result<()> {
        for material in &decoded.wrappers {
            let wrapper = &material.record;
            if !matches!(wrapper.kind, 1 | 2) {
                continue;
            }
            self.wrapper_ids.push(&wrapper.wrapper_id);
            self.node_ids.push(super::identifier(&wrapper.node_id));
            self.parent_node_ids
                .push(wrapper.parent_node_id.as_ref().map(super::identifier));
            self.kinds.push(if wrapper.kind == 1 {
                "account_root"
            } else {
                "parent_node"
            });
            self.record_versions.push(
                i64::try_from(wrapper.record_version)
                    .map_err(|_| error::ErrorBadRequest("wrapper version is invalid"))?,
            );
            self.canonical_cbors.push(&material.canonical);
            self.hashes.push(&material.hash);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn inline_batches_lock_once_and_write_set_wise() {
        let source = include_str!("vault_inline_batches.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        let publication = production
            .split_once("pub(super) async fn publish_inline_batch(")
            .map(|(_, tail)| tail)
            .unwrap();
        // One owner-wide lock and one commit cover the whole window.
        assert_eq!(publication.matches("lock_share_topology(").count(), 1);
        assert_eq!(
            publication
                .matches("transaction\n        .commit()")
                .count(),
            1
        );
        // Files the batch cannot vouch for, and a batch whose writes fail,
        // fall back to the shared per-file publication in a savepoint.
        assert!(publication.contains("publish_record_in_transaction("));
        assert!(publication.contains("savepoint\n                    .rollback()"));
        // Every write covers the whole batch.
        let writes = production
            .split_once("async fn publish_batch(")
            .map(|(_, tail)| tail)
            .unwrap();
        assert!(!writes.contains("VALUES ("));
        for table in [
            "INSERT INTO files",
            "UPDATE files",
            "INSERT INTO vault_node_records",
            "INSERT INTO vault_wrappers",
            "INSERT INTO vault_node_heads",
            "INSERT INTO vault_object_generations",
            "UPDATE vault_uploads",
        ] {
            assert_eq!(writes.matches(table).count(), 1, "{table}");
        }
        // Reservations are admitted against the locked ledger with the same
        // rule as the per-file reservation.
        let staging = production
            .split_once("async fn reserve_planned_uploads(")
            .and_then(|(_, tail)| tail.split_once("pub(super) struct InlinePublication"))
            .map(|(staging, _)| staging)
            .unwrap();
        assert!(staging.contains("FOR UPDATE"));
        assert!(staging.contains("usage.reserve("));
        assert!(staging.contains("\"vault-upload:{}:{node_id}\""));
    }
}

#[cfg(test)]
mod database_tests {
    use actix_web::cookie::Cookie;
    use actix_web::test::TestRequest;
    use bytes::Bytes;

    use super::super::super::upload_reservations::{
        MAX_PENDING_UPLOADS, is_reservation_contention,
    };
    use super::super::{abort_vault_upload_row, publish_record_transaction, random_id};
    use super::*;
    use crate::e2ee::{BootstrapRecord, DecodedWrapper, VerifiedNodeRecord, WrapperMaterialRecord};

    const CIPHERTEXT_LENGTH: u64 = 4_112;

    struct Owner {
        user: SessionPrincipal,
        tag: String,
        folder: String,
    }

    async fn owner(state: &AppState, scenario: &str) -> Owner {
        let tag = format!("{scenario}{}", random_id().unwrap().replace(['-', '_'], ""));
        let user_id = format!("usr_inline_{tag}");
        let token = format!("token_{tag}");
        let folder = format!("fil_{tag}_folder");
        state
            .db
            .execute(
                "INSERT INTO users(id,username,password_hash,role,status) VALUES($1,$1,'test','user','active')",
                &[&user_id],
            )
            .await
            .unwrap();
        state
            .db
            .execute(
                "
                    INSERT INTO vault_identity_keys (
                      user_id, key_version, x25519_public_key, ed25519_public_key,
                      fingerprint_sha256
                    )
                    VALUES ($1, 1, gen_random_bytes(32), gen_random_bytes(32), gen_random_bytes(32))
                ",
                &[&user_id],
            )
            .await
            .unwrap();
        let hash = crate::auth::hash_session_token(&token);
        state
            .db
            .execute(
                "INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'csrf',now()+interval '1 hour')",
                &[&format!("ses_{tag}"), &user_id, &hash.as_slice()],
            )
            .await
            .unwrap();
        state
            .db
            .execute(
                "
                    INSERT INTO files (
                      id, owner_id, original_name, storage_name, size_bytes,
                      entry_type, e2ee_state, current_generation_number,
                      current_generation_id
                    )
                    VALUES ($1, $2, 'encrypted-folder', 'vault-folder/' || $1, 0,
                            'folder', 'encrypted', 1, $3)
                ",
                &[&folder, &user_id, &[1_u8; 16].as_slice()],
            )
            .await
            .unwrap();
        let request = TestRequest::post()
            .cookie(Cookie::new(crate::auth::SESSION_COOKIE, token))
            .to_http_request();
        let user = crate::auth::require_principal(state, &request)
            .await
            .unwrap();
        Owner { user, tag, folder }
    }

    fn label(slot: &str, generation: u64, name: &str) -> [u8; 32] {
        crate::e2ee::sha256(format!("{slot}:{generation}:{name}").as_bytes())
    }

    /// A record whose compared bytes depend only on its slot, so two owners
    /// publish identical content under their own node ids. Slots of at least
    /// eight characters keep the owner out of the encrypted placeholder name.
    fn record(
        owner: &Owner,
        slot: &str,
        parent: Option<&str>,
        generation_number: u64,
        record_version: u64,
        previous_record_hash: Option<[u8; 32]>,
    ) -> DecodedNodeRecord {
        let node_id = format!("fil_{}_{slot}", owner.tag);
        let unique = |name: &str| label(&node_id, generation_number, name);
        let canonical = Bytes::from([unique("canonical"), unique("canonical-tail")].concat());
        let wrapper = DecodedWrapper {
            hash: crate::e2ee::sha256(&canonical),
            canonical,
            record: WrapperMaterialRecord {
                format_version: 1,
                wrapper_id: unique("wrapper")[..16].try_into().unwrap(),
                kind: if parent.is_some() { 2 } else { 1 },
                node_id: Bytes::from(node_id.clone()),
                parent_node_id: parent.map(|parent| Bytes::from(parent.to_owned())),
                generation_id: None,
                share_id: None,
                epoch: None,
                record_version,
                ciphertext: Bytes::from_static(&[9_u8; 48]),
                aad_schema_id: 1,
            },
        };
        let record_hash = unique("record");
        let generation_id: [u8; 16] = label(slot, generation_number, "generation")[..16]
            .try_into()
            .unwrap();
        DecodedNodeRecord {
            bootstrap_cbor: Bytes::from(label(slot, generation_number, "bootstrap").repeat(5)),
            signature: Bytes::from(label(slot, generation_number, "signature").repeat(2)),
            encrypted_manifest: Bytes::from(label(slot, generation_number, "manifest").to_vec()),
            wrappers: vec![wrapper],
            verified: VerifiedNodeRecord {
                bootstrap: BootstrapRecord {
                    format_version: 1,
                    suite_id: 1,
                    aad_schema_id: 1,
                    node_id,
                    generation_number,
                    generation_id,
                    manifest_iv: [0_u8; 12],
                    wrapper_ids: Vec::new(),
                    ciphertext_length: CIPHERTEXT_LENGTH,
                    signer_key_version: 1,
                    record_version,
                    previous_record_hash,
                    manifest_hash: label(slot, generation_number, "manifest-hash"),
                    wrapper_hashes: Vec::new(),
                    ciphertext_merkle_root: label(slot, generation_number, "merkle"),
                },
                // Record hashes are unique across owners; snapshots map them back.
                record_hash,
            },
        }
    }

    struct Item {
        init: VaultUploadInitRequest,
        decoded: DecodedNodeRecord,
        checksum: String,
    }

    fn item(owner: &Owner, decoded: DecodedNodeRecord, parent: Option<&str>) -> Item {
        let bootstrap = &decoded.verified.bootstrap;
        Item {
            init: VaultUploadInitRequest {
                node_id: bootstrap.node_id.clone(),
                parent_id: parent.map(str::to_owned),
                entry_type: "file".to_owned(),
                generation_number: bootstrap.generation_number,
                generation_id: encode_bytes(bootstrap.generation_id),
                ciphertext_length: bootstrap.ciphertext_length,
                chunk_count: 1,
                migration: false,
                checksum_sha256: None,
            },
            checksum: encode_bytes(label(
                &bootstrap.node_id.replace(&owner.tag, ""),
                bootstrap.generation_number,
                "checksum",
            )),
            decoded,
        }
    }

    async fn stage(state: &AppState, owner: &Owner, items: &[Item]) -> Vec<InlineStageOutcome> {
        let requests = items
            .iter()
            .map(|item| InlineStageRequest {
                init: &item.init,
                decoded: &item.decoded,
                checksum_sha256: &item.checksum,
            })
            .collect::<Vec<_>>();
        stage_inline_batch(state, &owner.user, &requests).await
    }

    fn metadata(item: &Item) -> ObjectMetadata {
        ObjectMetadata {
            size_bytes: CIPHERTEXT_LENGTH,
            checksum_sha256: Some(item.checksum.clone()),
            etag: Some(format!("etag-{}", item.checksum)),
        }
    }

    fn staged(outcomes: Vec<InlineStageOutcome>) -> Vec<VaultUpload> {
        outcomes
            .into_iter()
            .map(|outcome| match outcome {
                InlineStageOutcome::Staged(upload) => *upload,
                _ => panic!("every fixture file must be staged by the batch"),
            })
            .collect()
    }

    /// Everything a publication leaves behind for one owner, with the owner's
    /// identifiers and per-attempt randomness removed.
    async fn snapshot(
        state: &AppState,
        owner: &Owner,
        records: &[&DecodedNodeRecord],
    ) -> Vec<String> {
        let rows = state
            .db
            .query(
                "
                    SELECT 'files ' || (to_jsonb(f) - ARRAY['created_at', 'updated_at']
                      || jsonb_build_object('storage_name', f.storage_name = COALESCE((
                        SELECT u.object_key FROM vault_uploads u
                        WHERE u.node_id = f.id AND u.status = 'published'
                        ORDER BY u.generation_number DESC LIMIT 1
                      ), 'vault-folder/' || f.id)))::text
                    FROM files f WHERE owner_id = $1
                    UNION ALL
                    SELECT 'records ' || (to_jsonb(r) - 'created_at')::text
                    FROM vault_node_records r WHERE owner_id = $1
                    UNION ALL
                    SELECT 'wrappers ' || (to_jsonb(w) - ARRAY['created_at', 'wrapper_id',
                      'canonical_cbor', 'wrapper_hash'])::text
                    FROM vault_wrappers w WHERE owner_id = $1
                    UNION ALL
                    SELECT 'heads ' || (to_jsonb(h) - ARRAY['created_at', 'updated_at'])::text
                    FROM vault_node_heads h WHERE owner_id = $1
                    UNION ALL
                    SELECT 'generations ' || (to_jsonb(g) - ARRAY['created_at', 'retired_at',
                      'object_key'] || jsonb_build_object('retired', g.retired_at IS NOT NULL))::text
                    FROM vault_object_generations g WHERE owner_id = $1
                    UNION ALL
                    SELECT 'uploads ' || (to_jsonb(u) - ARRAY['id', 'object_key', 'created_at',
                      'published_at', 'expires_at', 'write_expires_at'])::text
                    FROM vault_uploads u WHERE owner_id = $1
                    UNION ALL
                    SELECT 'sync ' || (to_jsonb(j) - ARRAY['created_at', 'updated_at'])::text
                    FROM vault_share_sync_jobs j WHERE owner_id = $1
                    UNION ALL
                    SELECT 'usage ' || (to_jsonb(s) - 'updated_at')::text
                    FROM user_storage_usage s WHERE owner_id = $1
                    UNION ALL
                    SELECT 'counters ' || (to_jsonb(c) - 'updated_at')::text
                    FROM user_file_counters c WHERE owner_id = $1
                    UNION ALL
                    SELECT DISTINCT 'collection ' || parent_id
                    FROM collection_timestamp_changes WHERE owner_id = $1
                    UNION ALL
                    SELECT 'deletion ' || count(*)::text FROM storage_deletion_jobs
                    WHERE object_key LIKE 'users/' || $1 || '/%'
                    UNION ALL
                    SELECT 'realtime ' || scope || ' ' || CASE
                      WHEN bool_or(cardinality(folder_ids) = 0) THEN 'all'
                      ELSE (SELECT string_agg(DISTINCT folder, ',' ORDER BY folder)
                            FROM realtime_outbox o, unnest(o.folder_ids) AS folder
                            WHERE o.user_id = $1 AND o.scope = outbox.scope)
                    END
                    FROM realtime_outbox AS outbox WHERE user_id = $1 GROUP BY scope
                    UNION ALL
                    SELECT DISTINCT 'audience ' || kind || ' ' || entity_id
                    FROM realtime_audience_jobs WHERE owner_id = $1
                ",
                &[&owner.user.id],
            )
            .await
            .unwrap();
        let mut snapshot = rows
            .into_iter()
            .map(|row| {
                records
                    .iter()
                    .fold(row.get::<_, String>(0), |row, decoded| {
                        let bootstrap = &decoded.verified.bootstrap;
                        row.replace(
                            &decoded
                                .verified
                                .record_hash
                                .iter()
                                .map(|byte| format!("{byte:02x}"))
                                .collect::<String>(),
                            &format!(
                                "<record {} {}>",
                                bootstrap.node_id, bootstrap.record_version
                            ),
                        )
                    })
            })
            .map(|row| row.replace(&owner.tag, "<owner>"))
            .collect::<Vec<_>>();
        snapshot.sort();
        snapshot
    }

    async fn statement_calls(state: &AppState) -> Option<(i64, i64)> {
        state
            .db
            .query_opt(
                "
                    SELECT COALESCE(sum(calls) FILTER (WHERE toplevel), 0)::bigint,
                           COALESCE(sum(calls), 0)::bigint
                    FROM pg_stat_statements
                    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                ",
                &[],
            )
            .await
            .ok()
            .flatten()
            .map(|row| (row.get(0), row.get(1)))
    }

    fn outcome_shape(outcome: &Result<PublishResponse>) -> String {
        match outcome {
            Ok(published) => format!(
                "published {} {} {} {}",
                published.node_id.split('_').next_back().unwrap_or_default(),
                published.generation_number,
                published.record_version,
                published.share_sync_required
            ),
            Err(failure) => format!(
                "failed {} {}",
                failure.as_response_error().status_code(),
                failure
            ),
        }
    }

    /// Publishes the same window for two owners, one file per transaction and
    /// as one batch, and returns each owner's outcomes and resulting state.
    async fn publish_both_ways(state: &AppState) -> [(Vec<String>, Vec<String>); 2] {
        let mut results = Vec::new();
        for batched in [false, true] {
            let owner = owner(state, if batched { "b" } else { "a" }).await;
            let folder = owner.folder.clone();
            // A file published earlier, replaced by this window.
            let seed = item(
                &owner,
                record(&owner, "replaced", Some(&folder), 1, 1, None),
                Some(&folder),
            );
            let upload = staged(stage(state, &owner, std::slice::from_ref(&seed)).await)
                .pop()
                .unwrap();
            publish_record_transaction(
                state,
                &owner.user,
                &upload,
                &seed.decoded,
                Some(&metadata(&seed)),
            )
            .await
            .unwrap();
            let seed_hash = seed.decoded.verified.record_hash;
            let seed_decoded = &seed.decoded;

            let mut window = (1..=3)
                .map(|slot| {
                    let slot = format!("newfile{slot}");
                    item(
                        &owner,
                        record(&owner, &slot, Some(&folder), 1, 1, None),
                        Some(&folder),
                    )
                })
                .collect::<Vec<_>>();
            window.push(item(
                &owner,
                record(&owner, "rootfile", None, 1, 1, None),
                None,
            ));
            window.push(item(
                &owner,
                record(&owner, "replaced", Some(&folder), 2, 2, Some(seed_hash)),
                Some(&folder),
            ));
            // A new node that claims a later record version fails alone.
            window.push(item(
                &owner,
                record(&owner, "stalefile", Some(&folder), 1, 2, Some([7_u8; 32])),
                Some(&folder),
            ));
            // A wrapper naming the root while the upload names a folder.
            window.push(item(
                &owner,
                record(&owner, "misplaced", None, 1, 1, None),
                Some(&folder),
            ));
            let uploads = staged(stage(state, &owner, &window).await);
            let metadata = window.iter().map(metadata).collect::<Vec<_>>();

            let before = statement_calls(state).await;
            let outcomes = if batched {
                let publications = window
                    .iter()
                    .zip(&uploads)
                    .zip(&metadata)
                    .map(|((item, upload), metadata)| InlinePublication {
                        upload,
                        decoded: &item.decoded,
                        metadata,
                    })
                    .collect::<Vec<_>>();
                publish_inline_batch(state, &owner.user, &publications)
                    .await
                    .unwrap()
            } else {
                let mut outcomes = Vec::new();
                for ((item, upload), metadata) in window.iter().zip(&uploads).zip(&metadata) {
                    outcomes.push(
                        publish_record_transaction(
                            state,
                            &owner.user,
                            upload,
                            &item.decoded,
                            Some(metadata),
                        )
                        .await,
                    );
                }
                outcomes
            };
            if let (Some(before), Some(after)) = (before, statement_calls(state).await) {
                println!(
                    "{} files {}: {} client statements, {} with triggers",
                    window.len(),
                    if batched {
                        "in one batch"
                    } else {
                        "one by one"
                    },
                    after.0 - before.0,
                    after.1 - before.1
                );
            }
            // Failed files keep their reservation until the caller aborts them.
            for (outcome, upload) in outcomes.iter().zip(&uploads) {
                if outcome.is_err() {
                    abort_vault_upload_row(state, &owner.user.id, &upload.id)
                        .await
                        .unwrap();
                }
            }
            results.push((
                outcomes.iter().map(outcome_shape).collect(),
                snapshot(
                    state,
                    &owner,
                    &std::iter::once(seed_decoded)
                        .chain(window.iter().map(|item| &item.decoded))
                        .collect::<Vec<_>>(),
                )
                .await,
            ));
        }
        results.try_into().ok().unwrap()
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn batched_publication_leaves_the_state_of_one_by_one_publication() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let state = crate::state::database_test_state(1).await;
        let [(one_by_one, one_by_one_state), (batched, batched_state)] =
            publish_both_ways(&state).await;
        assert_eq!(batched, one_by_one);
        assert_eq!(
            batched
                .iter()
                .filter(|outcome| outcome.starts_with("published"))
                .count(),
            5,
            "{batched:?}"
        );
        assert!(batched[5].starts_with("failed 409"), "{batched:?}");
        assert!(batched[6].starts_with("failed 400"), "{batched:?}");
        assert_eq!(batched_state, one_by_one_state);
    }

    /// Reports the statements one window of new files costs. Run with
    /// --nocapture; the bounds only guard against a per-file regression.
    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn batched_window_statement_counts() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let state = crate::state::database_test_state(1).await;
        if statement_calls(&state).await.is_none() {
            return;
        }
        let mut counts = Vec::new();
        for batched in [false, true] {
            let owner = owner(&state, if batched { "e" } else { "d" }).await;
            let folder = owner.folder.clone();
            let window = (1..=4)
                .map(|slot| {
                    let slot = format!("countfile{slot}");
                    item(
                        &owner,
                        record(&owner, &slot, Some(&folder), 1, 1, None),
                        Some(&folder),
                    )
                })
                .collect::<Vec<_>>();
            let before = statement_calls(&state).await.unwrap();
            let uploads = staged(stage(&state, &owner, &window).await);
            let staged_at = statement_calls(&state).await.unwrap();
            let metadata = window.iter().map(metadata).collect::<Vec<_>>();
            if batched {
                let publications = window
                    .iter()
                    .zip(&uploads)
                    .zip(&metadata)
                    .map(|((item, upload), metadata)| InlinePublication {
                        upload,
                        decoded: &item.decoded,
                        metadata,
                    })
                    .collect::<Vec<_>>();
                for outcome in publish_inline_batch(&state, &owner.user, &publications)
                    .await
                    .unwrap()
                {
                    outcome.unwrap();
                }
            } else {
                for ((item, upload), metadata) in window.iter().zip(&uploads).zip(&metadata) {
                    publish_record_transaction(
                        &state,
                        &owner.user,
                        upload,
                        &item.decoded,
                        Some(metadata),
                    )
                    .await
                    .unwrap();
                }
            }
            let published_at = statement_calls(&state).await.unwrap();
            // The counting query itself is one top-level call per phase.
            let staging = (staged_at.0 - before.0 - 1, staged_at.1 - before.1 - 1);
            let publication = (
                published_at.0 - staged_at.0 - 1,
                published_at.1 - staged_at.1 - 1,
            );
            println!(
                "4 new files, publication {}: staging {staging:?}, publication {publication:?} \
                 (client statements, with triggers)",
                if batched { "batched" } else { "one by one" },
            );
            counts.push(publication);
        }
        assert!(counts[1].0 * 2 < counts[0].0, "{counts:?}");
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn batched_reservations_follow_the_owner_ledger() {
        if std::env::var("AERALYTH_DATABASE_INTEGRATION_TESTS").as_deref() != Ok("1") {
            return;
        }
        let state = crate::state::database_test_state(1).await;
        let owner = owner(&state, "c").await;
        let folder = owner.folder.clone();
        let window = (1..=4)
            .map(|slot| {
                let slot = format!("slot{slot}");
                item(
                    &owner,
                    record(&owner, &slot, Some(&folder), 1, 1, None),
                    Some(&folder),
                )
            })
            .collect::<Vec<_>>();

        // The batch stages a file as a client-driven upload leaves it once its
        // checksum is bound, and books its reservation once.
        let uploads = staged(stage(&state, &owner, &window[..1]).await);
        let row = state
            .db
            .query_one(
                "
                    SELECT u.status, u.upload_mode, u.checksum_sha256, u.reservation_bytes,
                           u.write_expires_at > now() AS writable, s.pending_uploads,
                           s.reserved_bytes
                    FROM vault_uploads u JOIN user_storage_usage s USING (owner_id)
                    WHERE u.id = $1
                ",
                &[&uploads[0].id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>("status"), "pending");
        assert_eq!(row.get::<_, String>("upload_mode"), "single");
        assert_eq!(
            row.get::<_, Option<String>>("checksum_sha256"),
            Some(window[0].checksum.clone())
        );
        assert_eq!(
            row.get::<_, i64>("reservation_bytes"),
            CIPHERTEXT_LENGTH as i64
        );
        assert!(row.get::<_, bool>("writable"));
        assert_eq!(row.get::<_, i64>("pending_uploads"), 1);
        assert_eq!(
            row.get::<_, i64>("reserved_bytes"),
            CIPHERTEXT_LENGTH as i64
        );

        // The same generation again resumes through the per-file path.
        assert!(matches!(
            stage(&state, &owner, &window[..1]).await.as_slice(),
            [InlineStageOutcome::Individually]
        ));

        // With one slot left, the next file takes it and the rest wait.
        state
            .db
            .execute(
                "UPDATE user_storage_usage SET pending_uploads = $2 WHERE owner_id = $1",
                &[&owner.user.id, &(MAX_PENDING_UPLOADS - 1)],
            )
            .await
            .unwrap();
        let outcomes = stage(&state, &owner, &window[1..]).await;
        assert!(matches!(outcomes[0], InlineStageOutcome::Staged(_)));
        for outcome in &outcomes[1..] {
            match outcome {
                InlineStageOutcome::Refused(failure) => assert!(is_reservation_contention(failure)),
                _ => panic!("a file without a slot must wait for one"),
            }
        }

        // Quota refusals are final and leave the ledger untouched.
        state
            .db
            .execute(
                "UPDATE user_storage_usage SET pending_uploads = 0, used_bytes = $2 WHERE owner_id = $1",
                &[
                    &owner.user.id,
                    &(i64::try_from(state.config.storage_quota_bytes).unwrap()),
                ],
            )
            .await
            .unwrap();
        let outcomes = stage(&state, &owner, &window[2..3]).await;
        match &outcomes[0] {
            InlineStageOutcome::Refused(failure) => {
                assert_eq!(
                    failure.as_response_error().status_code(),
                    actix_web::http::StatusCode::PAYLOAD_TOO_LARGE
                );
                assert!(!is_reservation_contention(failure));
            }
            _ => panic!("a file over quota must be refused"),
        }
        let pending: i64 = state
            .db
            .query_one(
                "SELECT pending_uploads FROM user_storage_usage WHERE owner_id = $1",
                &[&owner.user.id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(pending, 0);
    }
}
