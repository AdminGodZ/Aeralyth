//! Small encrypted files published in one request.
//!
//! A browser upload of a small file otherwise costs an init request, a
//! cross-origin preflight, a storage PUT and a publish request, which dominates
//! folders of many small files. Here the client sends the ciphertext and signed
//! record of many files together and the server drives each through the same
//! reservation, storage and publication steps as a client-driven upload.

use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;

use super::super::upload_reservations::is_reservation_contention;
use super::{
    DecodedNodeRecord, PublishResponse, VaultUpload, VaultUploadInitRequest,
    abort_vault_upload_row, active_signing_identities, bind_single_upload_checksum,
    current_publish_record, encode_bytes, is_binary_publication, publish_record_transaction,
    read_publication_body, require_configured_vault, require_vault_enabled, run_publication_decode,
    stage_vault_upload, validate_node_publication_material, validate_record_for_upload,
};
use crate::auth::{SessionPrincipal, require_header_csrf, require_principal};
use crate::e2ee::sha256;
use crate::state::{AppState, LoadShedError};
use crate::storage::ObjectMetadata;
use crate::vault_wire::{self, InlineUpload, MAX_INLINE_UPLOAD_BYTES};

/// Record framing on top of the ciphertext a batch may carry.
const INLINE_BATCH_BODY_LIMIT: usize = 9 * 1024 * 1024;
/// Uploads of one request between reservation and publication. Each holds one
/// of the owner's pending-upload slots, so three concurrent requests stay
/// within that limit and leave room for the owner's other uploads.
const INLINE_UPLOAD_WINDOW: usize = 4;
const _: () = assert!(
    3 * INLINE_UPLOAD_WINDOW as i64 <= super::super::upload_reservations::MAX_PENDING_UPLOADS - 4
);
const _: () = assert!(MAX_INLINE_UPLOAD_BYTES as u64 <= crate::e2ee::UPLOAD_PART_BYTES);
/// How long one file waits for a pending-upload slot the owner's other
/// uploads hold. Slots turn over within a publication, so a short wait
/// replaces a round trip to the client; a longer one means they are not ours.
const RESERVATION_RETRY_DELAYS_MS: [u64; 8] = [25, 50, 100, 200, 400, 400, 400, 400];

struct InlineCandidate {
    parent_id: Option<String>,
    chunk_count: u32,
    decoded: DecodedNodeRecord,
    content: Bytes,
    checksum_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum InlineUploadOutcome {
    Published(PublishResponse),
    Failed { status: u16, message: String },
}

#[derive(Serialize)]
struct InlineUploadsResponse {
    results: Vec<InlineUploadOutcome>,
}

pub async fn publish_inline_uploads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    if !is_binary_publication(&request) {
        return Err(error::ErrorUnsupportedMediaType(
            "inline uploads require the vault binary publication format",
        ));
    }
    state.db.release_request_connection().await;
    let mutation_permit = state
        .upload_control_limiter
        .try_acquire(&user.id)
        .map_err(|()| LoadShedError::too_many_requests("vault mutation capacity is full"))?;
    let bytes = read_publication_body(&request, body, INLINE_BATCH_BODY_LIMIT).await?;
    let identities = active_signing_identities(&state, &user).await?;
    let candidates = run_publication_decode(&state, &user.id, move || {
        let batch = vault_wire::decode_inline_upload_batch(bytes)
            .map_err(|failure| (400_u16, failure.to_string()))?;
        Ok(batch
            .uploads
            .into_iter()
            .map(|upload| inline_candidate(upload, &identities))
            .collect::<Vec<_>>())
    })
    .await?;

    // Staged uploads hold the owner's pending slots until they publish or
    // abort, so a batch runs to completion even when its client goes away.
    let processing = actix_web::rt::spawn(crate::db::scope_request(async move {
        let _mutation_permit = mutation_permit;
        publish_candidates(&state, &request, &user, candidates).await
    }));
    let (results, _) = processing
        .await
        .map_err(|_| error::ErrorServiceUnavailable("inline upload worker failed"))?;

    Ok(HttpResponse::Ok().json(InlineUploadsResponse { results }))
}

async fn publish_candidates(
    state: &AppState,
    request: &HttpRequest,
    user: &SessionPrincipal,
    candidates: Vec<std::result::Result<InlineCandidate, (u16, String)>>,
) -> Vec<InlineUploadOutcome> {
    // Reservations and publications of one request share a single database
    // lane, so a batch never holds more than one pooled connection at a time;
    // only the storage writes between them overlap.
    let database_lane = tokio::sync::Mutex::new(());
    let mut completed = futures_util::stream::iter(candidates.into_iter().enumerate().map(
        |(index, candidate)| {
            let database_lane = &database_lane;
            async move {
                let outcome = match candidate {
                    Ok(candidate) => {
                        publish_inline_upload(state, request, user, database_lane, candidate).await
                    }
                    Err(failure) => Err(failure),
                };
                (index, outcome)
            }
        },
    ))
    .buffer_unordered(INLINE_UPLOAD_WINDOW)
    .collect::<Vec<_>>()
    .await;
    completed.sort_by_key(|(index, _)| *index);
    completed
        .into_iter()
        .map(|(_, outcome)| match outcome {
            Ok(published) => InlineUploadOutcome::Published(published),
            Err((status, message)) => InlineUploadOutcome::Failed { status, message },
        })
        .collect()
}

/// Verifies one signed record and hashes its ciphertext on the validation
/// worker. A bad item fails alone; the rest of its batch still publishes.
fn inline_candidate(
    upload: InlineUpload,
    identities: &[(i64, Vec<u8>)],
) -> std::result::Result<InlineCandidate, (u16, String)> {
    let InlineUpload {
        parent_id,
        chunk_count,
        record,
        content,
    } = upload;
    let decoded = validate_node_publication_material(record, identities.to_vec())
        .map_err(|(forbidden, message)| (if forbidden { 403 } else { 400 }, message))?;
    if u64::try_from(content.len()).ok() != Some(decoded.verified.bootstrap.ciphertext_length) {
        return Err((
            400,
            "inline ciphertext does not match the signed bootstrap length".to_owned(),
        ));
    }
    let checksum_sha256 = STANDARD.encode(sha256(&content));
    Ok(InlineCandidate {
        parent_id,
        chunk_count,
        decoded,
        content,
        checksum_sha256,
    })
}

async fn publish_inline_upload(
    state: &AppState,
    request: &HttpRequest,
    user: &SessionPrincipal,
    database_lane: &tokio::sync::Mutex<()>,
    candidate: InlineCandidate,
) -> std::result::Result<PublishResponse, (u16, String)> {
    let InlineCandidate {
        parent_id,
        chunk_count,
        decoded,
        content,
        checksum_sha256,
    } = candidate;
    let bootstrap = &decoded.verified.bootstrap;
    let init = VaultUploadInitRequest {
        node_id: bootstrap.node_id.clone(),
        parent_id,
        entry_type: "file".to_owned(),
        generation_number: bootstrap.generation_number,
        generation_id: encode_bytes(bootstrap.generation_id),
        ciphertext_length: bootstrap.ciphertext_length,
        chunk_count,
        migration: false,
        checksum_sha256: None,
    };

    let mut retry_delays = RESERVATION_RETRY_DELAYS_MS.into_iter();
    let staged = loop {
        let staged = {
            let _lane = database_lane.lock().await;
            let staged = stage_inline_upload(state, user, &init, &decoded, &checksum_sha256).await;
            state.db.release_request_connection().await;
            staged
        };
        match staged {
            Ok(staged) => break staged,
            Err(failure) => {
                // Wait outside the lane: the publications that free a slot
                // need it.
                match retry_delays.next() {
                    Some(delay) if is_reservation_contention(&failure) => {
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
                    _ => return Err(item_failure(failure)),
                }
            }
        }
    };
    let upload = match staged {
        StagedInlineUpload::AlreadyPublished(published) => return Ok(published),
        StagedInlineUpload::Pending(upload) => upload,
    };

    let outcome = store_and_publish(
        state,
        request,
        user,
        database_lane,
        &upload,
        &decoded,
        content,
        &checksum_sha256,
    )
    .await;
    let failure = match outcome {
        Ok(published) => return Ok(published),
        Err(failure) => failure,
    };

    let _lane = database_lane.lock().await;
    // A repeated request can lose the publication race to its first attempt;
    // the record is then already the node head and this attempt succeeded.
    let published = published_record(state, user, &decoded).await;
    if !matches!(published, Ok(Some(_))) {
        // Failed items must not hold their reservation until the lease expires.
        if let Err(abort_failure) = abort_vault_upload_row(state, &user.id, &upload.id).await {
            log::warn!(
                "inline upload {} could not be aborted: {abort_failure}",
                upload.id
            );
        }
    }
    state.db.release_request_connection().await;
    match published {
        Ok(Some(published)) => Ok(published),
        _ => Err(item_failure(failure)),
    }
}

enum StagedInlineUpload {
    AlreadyPublished(PublishResponse),
    Pending(VaultUpload),
}

async fn stage_inline_upload(
    state: &AppState,
    user: &SessionPrincipal,
    init: &VaultUploadInitRequest,
    decoded: &DecodedNodeRecord,
    checksum_sha256: &str,
) -> Result<StagedInlineUpload> {
    if let Some(published) = published_record(state, user, decoded).await? {
        return Ok(StagedInlineUpload::AlreadyPublished(published));
    }
    let (upload, _) = stage_vault_upload(state, user, init).await?;
    let staged = async {
        if upload.mode != "single" || upload.status != "pending" {
            return Err(error::ErrorConflict("upload cannot be published inline"));
        }
        validate_record_for_upload(decoded, &upload)?;
        if !bind_single_upload_checksum(state, &user.id, &upload.id, checksum_sha256).await? {
            return Err(error::ErrorConflict("upload checksum changed"));
        }
        Ok(())
    }
    .await;
    if let Err(failure) = staged {
        if let Err(abort_failure) = abort_vault_upload_row(state, &user.id, &upload.id).await {
            log::warn!(
                "inline upload {} could not be aborted: {abort_failure}",
                upload.id
            );
        }
        return Err(failure);
    }
    Ok(StagedInlineUpload::Pending(upload))
}

#[allow(clippy::too_many_arguments)]
async fn store_and_publish(
    state: &AppState,
    request: &HttpRequest,
    user: &SessionPrincipal,
    database_lane: &tokio::sync::Mutex<()>,
    upload: &VaultUpload,
    decoded: &DecodedNodeRecord,
    content: Bytes,
    checksum_sha256: &str,
) -> Result<PublishResponse> {
    let object_key = upload
        .object_key
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
    let metadata: ObjectMetadata = state
        .storage_operations
        .run(
            &user.id,
            state
                .storage
                .put_vault_object(object_key, content, checksum_sha256),
        )
        .await?
        .map_err(error::ErrorBadGateway)?;
    if u64::try_from(upload.ciphertext_length).ok() != Some(metadata.size_bytes)
        || metadata.checksum_sha256.as_deref() != Some(checksum_sha256)
    {
        return Err(error::ErrorBadGateway(
            "ciphertext object checksum verification failed",
        ));
    }

    let _lane = database_lane.lock().await;
    let _recursive_permit = state.acquire_recursive_operation(&user.id).await?;
    crate::auth::revalidate_principal(state, request).await?;
    let published = publish_record_transaction(state, user, upload, decoded, Some(&metadata)).await;
    state.db.release_request_connection().await;
    published
}

/// The publication of exactly this record when it already is the node head.
async fn published_record(
    state: &AppState,
    user: &SessionPrincipal,
    decoded: &DecodedNodeRecord,
) -> Result<Option<PublishResponse>> {
    let bootstrap = &decoded.verified.bootstrap;
    Ok(current_publish_record(state, &user.id, &bootstrap.node_id)
        .await?
        .filter(|published| {
            published.record_hash == encode_bytes(decoded.verified.record_hash)
                && published.generation_id == encode_bytes(bootstrap.generation_id)
                && u64::try_from(published.generation_number).ok()
                    == Some(bootstrap.generation_number)
        }))
}

/// Item failures travel inside a 200 response, so they keep their status but
/// never carry internal error detail.
fn item_failure(failure: actix_web::Error) -> (u16, String) {
    let status = failure.as_response_error().status_code();
    let message = if status.is_server_error() {
        log::warn!("inline upload failed: {failure}");
        status
            .canonical_reason()
            .unwrap_or("upload failed")
            .to_owned()
    } else {
        failure.to_string()
    };
    (status.as_u16(), message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_failures_keep_client_detail_and_hide_server_detail() {
        assert_eq!(
            item_failure(error::ErrorConflict(
                "node head changed; regenerate the record"
            )),
            (409, "node head changed; regenerate the record".to_owned())
        );
        assert_eq!(
            item_failure(error::ErrorInternalServerError(
                "relation \"secret\" is missing"
            )),
            (500, "Internal Server Error".to_owned())
        );
        assert_eq!(
            item_failure(
                LoadShedError::too_many_requests("upload control capacity is full").into()
            )
            .0,
            429
        );
    }

    #[test]
    fn inline_outcomes_serialize_as_tagged_results_in_request_order() {
        let response = InlineUploadsResponse {
            results: vec![
                InlineUploadOutcome::Published(PublishResponse {
                    node_id: "fil_node".to_owned(),
                    generation_number: 1,
                    generation_id: "generation".to_owned(),
                    record_version: 1,
                    record_hash: "hash".to_owned(),
                    share_sync_required: false,
                }),
                InlineUploadOutcome::Failed {
                    status: 409,
                    message: "conflict".to_owned(),
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "results": [
                    {"published": {
                        "nodeId": "fil_node",
                        "generationNumber": 1,
                        "generationId": "generation",
                        "recordVersion": 1,
                        "recordHash": "hash",
                        "shareSyncRequired": false,
                    }},
                    {"failed": {"status": 409, "message": "conflict"}},
                ],
            })
        );
    }

    #[test]
    fn inline_uploads_reuse_the_client_driven_upload_state_machine() {
        let source = include_str!("vault_inline_uploads.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        // Reservation, lease, publication and cleanup stay the single
        // implementation the client-driven flow uses.
        for shared in [
            "stage_vault_upload(",
            "bind_single_upload_checksum(",
            "validate_record_for_upload(",
            "publish_record_transaction(",
            "abort_vault_upload_row(",
        ] {
            assert!(production.contains(shared), "{shared} must stay shared");
        }
        assert!(!production.contains("INSERT INTO"));
        assert!(!production.contains("UPDATE "));
        // Authentication and admission precede the body, CPU work stays off
        // the Actix workers, and each publication revalidates the session.
        let handler = production
            .split_once("pub async fn publish_inline_uploads(")
            .and_then(|(_, tail)| tail.split_once("fn inline_candidate("))
            .map(|(handler, _)| handler)
            .unwrap();
        let position = |marker: &str| handler.find(marker).expect(marker);
        assert!(position("require_header_csrf") < position("upload_control_limiter"));
        assert!(position("upload_control_limiter") < position("read_publication_body"));
        assert!(position("read_publication_body") < position("run_publication_decode"));
        // A client that disconnects must not strand staged uploads in the
        // owner's pending slots: the batch finishes on its own task.
        assert!(position("run_publication_decode") < position("rt::spawn"));
        assert!(handler.contains("scope_request"));
        assert!(production.contains("acquire_recursive_operation"));
        assert!(production.contains("revalidate_principal"));
    }
}
