use std::collections::{HashMap, HashSet};

use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::future::try_join_all;
use serde::{Deserialize, Serialize};

use crate::auth::{SessionPrincipal, require_csrf, require_principal};
use crate::config::E2eeMode;
use crate::db::{query_one_cached, query_opt_cached};
use crate::e2ee::{
    ARGON2ID_ALGORITHM, ARGON2ID_MEMORY_BYTES, ARGON2ID_OPERATIONS, ARGON2ID_OUTPUT_BYTES,
    CRYPTO_CHUNK_BYTES, FORMAT_VERSION, MAX_CIPHERTEXT_BYTES, SHARE_DIRECTORY_VERSION,
    SHARE_ENVELOPE_VERSION, UPLOAD_PART_BYTES, WrapperSetCommitment, decode_bootstrap,
    decode_share_directory, decode_share_envelope, decode_wrapper, sha256,
    uses_vault_multipart_upload, verify_ed25519_signature, verify_node_record,
    verify_share_envelope, verify_wrapper_set_proof, wrapper_set_commitment,
};
use crate::routes::upload_reservations::{reservation_amount, reserve_upload_capacity};
use crate::state::AppState;
use crate::storage::{ObjectMetadata, UploadedPart};

const MAX_IDENTITY_PRIVATE_CIPHERTEXT: usize = 8_192;
const MAX_ACCOUNT_STATE_CIPHERTEXT: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_CIPHERTEXT: usize = 1024 * 1024;
const MAX_PRESIGN_PARTS: usize = 32;
const SHARED_DOWNLOAD_AUTHORIZATION_QUERY: &str = "
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM files
      WHERE id = $1 AND state = 'active' AND e2ee_state = 'encrypted'
      UNION ALL
      SELECT parent.id, parent.parent_id
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.state = 'active' AND parent.e2ee_state = 'encrypted'
    )
    SELECT shares.id, shares.owner_id, shares.root_node_id,
           shares.active_epoch, shares.record_version,
           shares.previous_record_hash,
           recipients.recipient_key_version,
           epochs.protocol_version, epochs.wrapper_set_root, epochs.wrapper_count
    FROM vault_shares AS shares
    INNER JOIN users AS owners
      ON owners.id = shares.owner_id
     AND owners.status = 'active'
    INNER JOIN ancestors ON ancestors.id = shares.root_node_id
    INNER JOIN vault_share_recipients AS recipients
      ON recipients.share_id = shares.id
     AND recipients.recipient_id = $2
     AND recipients.status = 'active'
    INNER JOIN vault_share_epochs AS epochs
      ON epochs.share_id = shares.id
     AND epochs.epoch = shares.active_epoch
     AND epochs.status = 'published'
    WHERE shares.status = 'active'
    ORDER BY shares.created_at
    LIMIT 1
    FOR SHARE OF shares, recipients, epochs
";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatusResponse {
    mode: String,
    configured: bool,
    vault_version: Option<i64>,
    migration: MigrationSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationSummary {
    legacy_nodes: i64,
    incomplete_nodes: i64,
    ready_for_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationClaimResponse {
    node: Option<MigrationNodeResponse>,
    migration: MigrationSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationNodeResponse {
    node_id: String,
    parent_id: Option<String>,
    entry_type: String,
    name: String,
    mime_type: Option<String>,
    plaintext_bytes: i64,
    last_modified: i64,
    download_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfRequest {
    algorithm: String,
    salt: String,
    operations: u64,
    memory_bytes: u64,
    output_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootWrapperRequest {
    id: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryWrapperRequest {
    salt: String,
    id: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentitySetupRequest {
    key_version: u64,
    x25519_public_key: String,
    ed25519_public_key: String,
    fingerprint_sha256: String,
    private_record_id: String,
    private_ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultSetupRequest {
    format_version: u64,
    kdf: KdfRequest,
    password_wrapper: RootWrapperRequest,
    recovery_wrapper: RecoveryWrapperRequest,
    identity: IdentitySetupRequest,
    account_state_record_id: Option<String>,
    encrypted_account_state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultRewrapRequest {
    expected_vault_version: u64,
    kdf: KdfRequest,
    password_wrapper: RootWrapperRequest,
    recovery_wrapper: RecoveryWrapperRequest,
    account_state_record_id: Option<String>,
    encrypted_account_state: Option<String>,
    recovery: Option<bool>,
    proof_signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultMutationResponse {
    vault_version: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnlockMaterialResponse {
    format_version: i16,
    vault_version: i64,
    kdf: KdfResponse,
    password_wrapper: RootWrapperResponse,
    recovery_wrapper: RecoveryWrapperResponse,
    identity: IdentityMaterialResponse,
    account_state_record_id: Option<String>,
    encrypted_account_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KdfResponse {
    algorithm: String,
    salt: String,
    operations: i64,
    memory_bytes: i64,
    output_bytes: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootWrapperResponse {
    id: String,
    ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryWrapperResponse {
    salt: String,
    id: String,
    ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityMaterialResponse {
    key_version: i64,
    x25519_public_key: String,
    ed25519_public_key: String,
    fingerprint_sha256: String,
    private_record_id: String,
    private_ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicIdentityResponse {
    user_id: String,
    username: String,
    key_version: i64,
    x25519_public_key: String,
    ed25519_public_key: String,
    fingerprint_sha256: String,
    trust_status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustIdentityRequest {
    key_version: u64,
    fingerprint_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultUploadInitRequest {
    node_id: String,
    parent_id: Option<String>,
    entry_type: String,
    generation_number: u64,
    generation_id: String,
    ciphertext_length: u64,
    chunk_count: u32,
    #[serde(default)]
    migration: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultUploadPlanResponse {
    upload_id: String,
    node_id: String,
    mode: String,
    part_size_bytes: Option<u64>,
    existing_parts: Vec<crate::storage::UploadPartPlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChecksumRequest {
    checksum_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadUrlResponse {
    url: String,
    content_length: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartChecksumRequest {
    part_number: i32,
    checksum_sha256: String,
}

#[derive(Deserialize)]
pub(crate) struct PartChecksumsRequest {
    parts: Vec<PartChecksumRequest>,
}

#[derive(Serialize)]
struct PartUrlsResponse {
    parts: Vec<PartUrlResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PartUrlResponse {
    part_number: i32,
    url: String,
    content_length: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedUploadPartRequest {
    part_number: i32,
    etag: String,
    checksum_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishUploadRequest {
    parts: Vec<CompletedUploadPartRequest>,
    bootstrap_cbor: String,
    bootstrap_signature: String,
    encrypted_manifest: String,
    wrappers: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishResponse {
    node_id: String,
    generation_number: i64,
    generation_id: String,
    record_version: i64,
    record_hash: String,
    share_sync_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishShareDirectoryRequest {
    directory_cbor: Option<String>,
    directory_signature: Option<String>,
    #[serde(default)]
    wrappers: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareSyncJobResponse {
    node_id: String,
    entry_type: String,
    generation_number: i64,
    generation_id: String,
    record_version: i64,
    record_hash: String,
}

#[derive(Serialize)]
struct ShareSyncJobsResponse {
    jobs: Vec<ShareSyncJobResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishRecordRequest {
    bootstrap_cbor: String,
    bootstrap_signature: String,
    encrypted_manifest: String,
    wrappers: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadPlanResponse {
    node_id: String,
    entry_type: String,
    generation_number: i64,
    generation_id: String,
    ciphertext_length: i64,
    crypto_chunk_bytes: i32,
    chunk_count: i32,
    ciphertext_merkle_root: String,
    download_url: Option<String>,
    bootstrap_cbor: String,
    bootstrap_signature: String,
    encrypted_manifest: String,
    wrappers: Vec<String>,
    signer_key_version: i64,
    signer_ed25519_public_key: String,
    record_version: i64,
    record_hash: String,
    share: Option<ShareDownloadMaterial>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareDownloadMaterial {
    share_id: String,
    epoch: i64,
    root_node_id: String,
    sender_id: String,
    recipient_id: String,
    record_version: i64,
    previous_record_hash: Option<String>,
    envelope_cbor: String,
    envelope_signature: String,
    envelope_hash: String,
    sender_key_version: i64,
    sender_x25519_public_key: String,
    sender_ed25519_public_key: String,
    sender_fingerprint_sha256: String,
    recipient_key_version: i64,
    wrapper_proofs: Vec<Option<ShareWrapperProofResponse>>,
    directory: Option<ShareDirectoryResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareDirectoryResponse {
    canonical_cbor: String,
    signature: String,
    wrapper_proofs: Vec<ShareWrapperProofResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareWrapperProofResponse {
    leaf_index: i32,
    proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedEnvelopeRequest {
    canonical_cbor: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerEpochKeyRequest {
    wrapper_id: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShareRequest {
    share_id: String,
    root_node_id: String,
    recipient_id: String,
    recipient_key_version: u64,
    wrappers: Vec<String>,
    envelopes: Vec<SignedEnvelopeRequest>,
    owner_epoch_key: OwnerEpochKeyRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareMutationResponse {
    share_id: String,
    active_epoch: i64,
    record_hash: String,
    limitation: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedShareResponse {
    share_id: String,
    root_node_id: String,
    active_epoch: i64,
    pending_epoch: Option<i64>,
    pending_revoked_recipient_id: Option<String>,
    status: String,
    recipients: Vec<OwnedShareRecipient>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedShareRecipient {
    user_id: String,
    username: String,
    key_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginEpochRotationRequest {
    revoked_recipient_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpochNodeSnapshot {
    node_id: String,
    entry_type: String,
    generation_number: i64,
    generation_id: Option<String>,
    record_version: i64,
    record_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePreparationResponse {
    nodes: Vec<EpochNodeSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveShareContextResponse {
    share_id: String,
    epoch: i64,
    wrapper_id: String,
    ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpochRecipient {
    user_id: String,
    key_version: i64,
    x25519_public_key: String,
    ed25519_public_key: String,
    fingerprint_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpochRotationPlanResponse {
    share_id: String,
    pending_epoch: i64,
    fence_snapshot_hash: String,
    nodes: Vec<EpochNodeSnapshot>,
    retained_recipients: Vec<EpochRecipient>,
    record_version: i64,
    previous_record_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishEpochRequest {
    fence_snapshot_hash: String,
    wrappers: Vec<String>,
    envelopes: Vec<SignedEnvelopeRequest>,
    owner_epoch_key: OwnerEpochKeyRequest,
}

struct ShareWrapperMaterial {
    canonical: Vec<u8>,
    record: crate::e2ee::WrapperRecord,
    hash: [u8; 32],
}

struct ShareEnvelopeMaterial {
    canonical: Vec<u8>,
    signature: Vec<u8>,
    record: crate::e2ee::ShareEnvelopeRecord,
    hash: [u8; 32],
}

struct OwnerEpochKeyMaterial {
    wrapper_id: [u8; 16],
    ciphertext: [u8; 48],
}

struct SnapshotNode {
    node_id: String,
    entry_type: String,
    generation_number: i64,
    generation_id: Option<Vec<u8>>,
    record_version: i64,
    record_hash: Vec<u8>,
}

struct VaultUpload {
    id: String,
    node_id: String,
    parent_id: Option<String>,
    entry_type: String,
    generation_number: i64,
    generation_id: Vec<u8>,
    object_key: Option<String>,
    ciphertext_length: i64,
    chunk_count: i32,
    mode: String,
    part_size_bytes: Option<i64>,
    multipart_upload_id: Option<String>,
    status: String,
    checksum_sha256: Option<String>,
}

struct DecodedNodeRecord {
    bootstrap_cbor: Vec<u8>,
    signature: Vec<u8>,
    encrypted_manifest: Vec<u8>,
    wrappers: Vec<Vec<u8>>,
    verified: crate::e2ee::VerifiedNodeRecord,
}

pub async fn status(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_principal(&state, &request).await?;
    let configured = state
        .db
        .query_opt(
            "SELECT vault_version FROM user_vaults WHERE user_id = $1",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let migration = migration_summary(&state, &user).await?;

    Ok(HttpResponse::Ok().json(VaultStatusResponse {
        mode: state.config.e2ee_mode.as_str().to_owned(),
        configured: configured.is_some(),
        vault_version: configured.map(|row| row.get("vault_version")),
        migration,
    }))
}

pub async fn claim_migration(
    state: web::Data<AppState>,
    request: HttpRequest,
) -> Result<HttpResponse> {
    if state.config.e2ee_mode != E2eeMode::Migrate {
        return Ok(HttpResponse::NotFound().finish());
    }
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let candidate = transaction
        .query_opt(
            "
                SELECT files.id, files.parent_id, files.entry_type,
                       files.original_name, files.mime_type, files.size_bytes,
                       files.storage_name,
                       (extract(epoch FROM files.updated_at) * 1000)::bigint AS last_modified
                FROM files
                LEFT JOIN files AS parent ON parent.id = files.parent_id
                WHERE files.owner_id = $1
                  AND files.e2ee_state IN ('legacy', 'staged')
                  AND (files.parent_id IS NULL OR parent.e2ee_state = 'encrypted')
                ORDER BY files.created_at, files.id
                LIMIT 1
                FOR UPDATE OF files SKIP LOCKED
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(candidate) = candidate else {
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::Ok().json(MigrationClaimResponse {
            node: None,
            migration: migration_summary(&state, &user).await?,
        }));
    };
    let node_id: String = candidate.get("id");
    let stale_upload = transaction
        .query_opt(
            "
                SELECT id, object_key, multipart_upload_id
                FROM vault_uploads
                WHERE owner_id = $1 AND node_id = $2
                  AND status IN ('initializing', 'pending', 'completing', 'aborting')
                LIMIT 1
                FOR UPDATE
            ",
            &[&user.id, &node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if let Some(stale_upload) = stale_upload {
        let upload_id: String = stale_upload.get("id");
        let object_key: Option<String> = stale_upload.get("object_key");
        let multipart_upload_id: Option<String> = stale_upload.get("multipart_upload_id");
        if let Some(object_key) = object_key {
            transaction
                .execute(
                    "
                        INSERT INTO storage_deletion_jobs (object_key, multipart_upload_id)
                        VALUES ($1, $2)
                        ON CONFLICT (object_key) DO UPDATE
                        SET multipart_upload_id = EXCLUDED.multipart_upload_id,
                            available_at = now(), locked_until = NULL
                    ",
                    &[&object_key, &multipart_upload_id],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
            transaction
                .execute(
                    "UPDATE vault_uploads SET status = 'aborting', expires_at = now() WHERE id = $1",
                    &[&upload_id],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
        } else {
            transaction
                .execute(
                    "UPDATE vault_uploads SET status = 'aborted' WHERE id = $1",
                    &[&upload_id],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
        }
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::Conflict()
            .body("an interrupted migration upload is being cleaned up; retry shortly"));
    }
    transaction
        .execute(
            "DELETE FROM vault_uploads WHERE owner_id = $1 AND node_id = $2 AND status = 'aborted'",
            &[&user.id, &node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let entry_type: String = candidate.get("entry_type");
    let legacy_object_key =
        (entry_type == "file").then(|| candidate.get::<_, String>("storage_name"));
    transaction
        .execute(
            "
                INSERT INTO vault_migrations (
                  node_id, owner_id, legacy_object_key, state, attempts, last_error
                ) VALUES ($1, $2, $3, 'encrypting', 1, NULL)
                ON CONFLICT (node_id) DO UPDATE
                SET state = 'encrypting', attempts = vault_migrations.attempts + 1,
                    legacy_object_key = EXCLUDED.legacy_object_key,
                    staged_object_key = NULL, last_error = NULL, updated_at = now()
            ",
            &[&node_id, &user.id, &legacy_object_key],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "UPDATE files SET e2ee_state = 'staged', updated_at = now() WHERE id = $1 AND owner_id = $2",
            &[&node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute("DELETE FROM file_shares WHERE file_id = $1", &[&node_id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    let response = MigrationNodeResponse {
        node_id: node_id.clone(),
        parent_id: candidate.get("parent_id"),
        entry_type: entry_type.clone(),
        name: candidate.get("original_name"),
        mime_type: candidate.get("mime_type"),
        plaintext_bytes: if entry_type == "file" {
            candidate.get("size_bytes")
        } else {
            0
        },
        last_modified: candidate.get("last_modified"),
        download_url: (entry_type == "file").then(|| format!("/api/files/{node_id}/download")),
    };
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(MigrationClaimResponse {
        node: Some(response),
        migration: migration_summary(&state, &user).await?,
    }))
}

pub async fn setup(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<VaultSetupRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let material = validate_setup_material(&body)?;
    let fingerprint =
        identity_fingerprint(&material.x25519_public_key, &material.ed25519_public_key);
    if fingerprint != material.fingerprint_sha256 {
        return Err(error::ErrorBadRequest("identity fingerprint is invalid"));
    }

    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let inserted = transaction
        .execute(
            "
                INSERT INTO user_vaults (
                  user_id, format_version, kdf_algorithm, kdf_salt,
                  kdf_operations, kdf_memory_bytes, kdf_output_bytes,
                  password_wrapper_id, password_root_ciphertext,
                  recovery_salt, recovery_wrapper_id, recovery_root_ciphertext,
                  identity_record_id, identity_private_ciphertext,
                  account_state_record_id, encrypted_account_state
                )
                VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                ON CONFLICT (user_id) DO NOTHING
            ",
            &[
                &user.id,
                &ARGON2ID_ALGORITHM,
                &material.kdf_salt,
                &(ARGON2ID_OPERATIONS as i64),
                &(ARGON2ID_MEMORY_BYTES as i64),
                &(ARGON2ID_OUTPUT_BYTES as i32),
                &material.password_wrapper_id,
                &material.password_root_ciphertext,
                &material.recovery_salt,
                &material.recovery_wrapper_id,
                &material.recovery_root_ciphertext,
                &material.identity_record_id,
                &material.identity_private_ciphertext,
                &material.account_state_record_id,
                &material.encrypted_account_state,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    if inserted != 1 {
        return Ok(HttpResponse::Conflict().body("vault is already configured"));
    }

    transaction
        .execute(
            "
                INSERT INTO vault_identity_keys (
                  user_id, key_version, x25519_public_key, ed25519_public_key,
                  fingerprint_sha256, status
                )
                VALUES ($1, $2, $3, $4, $5, 'active')
            ",
            &[
                &user.id,
                &(material.identity_key_version as i64),
                &material.x25519_public_key,
                &material.ed25519_public_key,
                &material.fingerprint_sha256,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if state.config.e2ee_mode == E2eeMode::Migrate {
        transaction
            .execute(
                "
                    DELETE FROM file_shares AS shares
                    USING files
                    WHERE shares.file_id = files.id
                      AND files.owner_id = $1
                      AND files.e2ee_state <> 'encrypted'
                ",
                &[&user.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Created().json(VaultMutationResponse { vault_version: 1 }))
}

pub async fn unlock_material(
    state: web::Data<AppState>,
    request: HttpRequest,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    let row = state
        .db
        .query_opt(
            "
                SELECT
                  vault.format_version, vault.vault_version,
                  vault.kdf_algorithm, vault.kdf_salt, vault.kdf_operations,
                  vault.kdf_memory_bytes, vault.kdf_output_bytes,
                  vault.password_wrapper_id, vault.password_root_ciphertext,
                  vault.recovery_salt, vault.recovery_wrapper_id,
                  vault.recovery_root_ciphertext, vault.identity_record_id,
                  vault.identity_private_ciphertext, vault.account_state_record_id,
                  vault.encrypted_account_state,
                  identity.key_version, identity.x25519_public_key,
                  identity.ed25519_public_key, identity.fingerprint_sha256
                FROM user_vaults AS vault
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = vault.user_id AND identity.status = 'active'
                WHERE vault.user_id = $1
                LIMIT 1
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().body("vault is not configured"));
    };

    Ok(HttpResponse::Ok().json(UnlockMaterialResponse {
        format_version: row.get("format_version"),
        vault_version: row.get("vault_version"),
        kdf: KdfResponse {
            algorithm: row.get("kdf_algorithm"),
            salt: encode_bytes(row.get::<_, Vec<u8>>("kdf_salt")),
            operations: row.get("kdf_operations"),
            memory_bytes: row.get("kdf_memory_bytes"),
            output_bytes: row.get("kdf_output_bytes"),
        },
        password_wrapper: RootWrapperResponse {
            id: encode_bytes(row.get::<_, Vec<u8>>("password_wrapper_id")),
            ciphertext: encode_bytes(row.get::<_, Vec<u8>>("password_root_ciphertext")),
        },
        recovery_wrapper: RecoveryWrapperResponse {
            salt: encode_bytes(row.get::<_, Vec<u8>>("recovery_salt")),
            id: encode_bytes(row.get::<_, Vec<u8>>("recovery_wrapper_id")),
            ciphertext: encode_bytes(row.get::<_, Vec<u8>>("recovery_root_ciphertext")),
        },
        identity: IdentityMaterialResponse {
            key_version: row.get("key_version"),
            x25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("x25519_public_key")),
            ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
            fingerprint_sha256: encode_bytes(row.get::<_, Vec<u8>>("fingerprint_sha256")),
            private_record_id: encode_bytes(row.get::<_, Vec<u8>>("identity_record_id")),
            private_ciphertext: encode_bytes(row.get::<_, Vec<u8>>("identity_private_ciphertext")),
        },
        account_state_record_id: row
            .get::<_, Option<Vec<u8>>>("account_state_record_id")
            .map(encode_bytes),
        encrypted_account_state: encode_bytes(row.get::<_, Vec<u8>>("encrypted_account_state")),
    }))
}

pub async fn rewrap(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<VaultRewrapRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    validate_kdf(&body.kdf)?;
    let kdf_salt = decode_fixed::<16>(&body.kdf.salt, "KDF salt")?.to_vec();
    let password_wrapper_id =
        decode_fixed::<16>(&body.password_wrapper.id, "password wrapper id")?.to_vec();
    let password_ciphertext = decode_fixed::<48>(
        &body.password_wrapper.ciphertext,
        "password root ciphertext",
    )?
    .to_vec();
    let recovery_salt = decode_fixed::<16>(&body.recovery_wrapper.salt, "recovery salt")?.to_vec();
    let recovery_wrapper_id =
        decode_fixed::<16>(&body.recovery_wrapper.id, "recovery wrapper id")?.to_vec();
    let recovery_ciphertext = decode_fixed::<48>(
        &body.recovery_wrapper.ciphertext,
        "recovery root ciphertext",
    )?
    .to_vec();
    let account_state_record_id = decode_optional_fixed::<16>(
        body.account_state_record_id.as_deref(),
        "account state record id",
    )?
    .map(Vec::from);
    let encrypted_account_state = decode_limited(
        body.encrypted_account_state.as_deref().unwrap_or(""),
        MAX_ACCOUNT_STATE_CIPHERTEXT,
        "encrypted account state",
    )?;
    let expected_version = i64::try_from(body.expected_vault_version)
        .map_err(|_| error::ErrorBadRequest("vault version is invalid"))?;
    let recovered_at = body.recovery.unwrap_or(false);
    let proof_signature = decode_fixed::<64>(&body.proof_signature, "rewrap proof signature")?;
    let proof = rewrap_proof_message(
        expected_version,
        recovered_at,
        &body.kdf,
        &kdf_salt,
        &password_wrapper_id,
        &password_ciphertext,
        &recovery_salt,
        &recovery_wrapper_id,
        &recovery_ciphertext,
        account_state_record_id.as_deref(),
        &encrypted_account_state,
    )?;
    let signer = active_identity(&state, &user.id).await?;
    verify_ed25519_signature(&proof, &proof_signature, &signer.ed25519_public_key)
        .map_err(error::ErrorForbidden)?;
    let row = state
        .db
        .query_opt(
            "
                UPDATE user_vaults
                SET vault_version = vault_version + 1,
                    kdf_salt = $1,
                    password_wrapper_id = $2,
                    password_root_ciphertext = $3,
                    recovery_salt = $4,
                    recovery_wrapper_id = $5,
                    recovery_root_ciphertext = $6,
                    account_state_record_id = $7,
                    encrypted_account_state = $8,
                    status = 'active',
                    recovered_at = CASE WHEN $9 THEN now() ELSE recovered_at END,
                    updated_at = now()
                WHERE user_id = $10 AND vault_version = $11
                RETURNING vault_version
            ",
            &[
                &kdf_salt,
                &password_wrapper_id,
                &password_ciphertext,
                &recovery_salt,
                &recovery_wrapper_id,
                &recovery_ciphertext,
                &account_state_record_id,
                &encrypted_account_state,
                &recovered_at,
                &user.id,
                &expected_version,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Ok(HttpResponse::Conflict().body("vault material changed; unlock again"));
    };

    Ok(HttpResponse::Ok().json(VaultMutationResponse {
        vault_version: row.get("vault_version"),
    }))
}

pub async fn identity(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    let username = path.into_inner();
    let row = state
        .db
        .query_opt(
            "
                SELECT users.id, users.username, identity.key_version,
                       identity.x25519_public_key, identity.ed25519_public_key,
                       identity.fingerprint_sha256,
                       COALESCE(trust.status, 'pending') AS trust_status
                FROM users
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = users.id AND identity.status = 'active'
                LEFT JOIN vault_identity_trust AS trust
                  ON trust.user_id = $1 AND trust.peer_user_id = users.id
                WHERE lower(users.username) = lower($2)
                  AND users.status = 'active'
                  AND users.id <> $1
                LIMIT 1
            ",
            &[&user.id, &username],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };

    Ok(HttpResponse::Ok().json(PublicIdentityResponse {
        user_id: row.get("id"),
        username: row.get("username"),
        key_version: row.get("key_version"),
        x25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("x25519_public_key")),
        ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
        fingerprint_sha256: encode_bytes(row.get::<_, Vec<u8>>("fingerprint_sha256")),
        trust_status: row.get("trust_status"),
    }))
}

pub async fn trust_identity(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<TrustIdentityRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let peer_user_id = path.into_inner();
    let key_version = i64::try_from(body.key_version)
        .map_err(|_| error::ErrorBadRequest("identity key version is invalid"))?;
    let fingerprint = decode_fixed::<32>(&body.fingerprint_sha256, "identity fingerprint")?;
    let exists = state
        .db
        .query_opt(
            "
                SELECT 1 FROM vault_identity_keys
                WHERE user_id = $1 AND key_version = $2
                  AND fingerprint_sha256 = $3 AND status = 'active'
            ",
            &[&peer_user_id, &key_version, &fingerprint.as_slice()],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if exists.is_none() || peer_user_id == user.id {
        return Err(error::ErrorBadRequest("identity key changed or is invalid"));
    }

    state
        .db
        .execute(
            "
                INSERT INTO vault_identity_trust (
                  user_id, peer_user_id, peer_key_version,
                  fingerprint_sha256, status, accepted_at
                )
                VALUES ($1, $2, $3, $4, 'accepted', now())
                ON CONFLICT (user_id, peer_user_id) DO UPDATE SET
                  peer_key_version = EXCLUDED.peer_key_version,
                  fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
                  status = 'accepted', accepted_at = now(), updated_at = now()
            ",
            &[
                &user.id,
                &peer_user_id,
                &key_version,
                &fingerprint.as_slice(),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::NoContent().finish())
}

pub async fn init_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<VaultUploadInitRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    validate_node_id(&body.node_id)?;
    let generation_id = decode_fixed::<16>(&body.generation_id, "generation id")?.to_vec();
    let generation_number = i64::try_from(body.generation_number)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| error::ErrorBadRequest("generation number is invalid"))?;
    let ciphertext_length = i64::try_from(body.ciphertext_length)
        .map_err(|_| error::ErrorPayloadTooLarge("ciphertext is too large"))?;
    let chunk_count = i32::try_from(body.chunk_count)
        .map_err(|_| error::ErrorBadRequest("chunk count is invalid"))?;
    validate_ciphertext_shape(
        &body.entry_type,
        body.ciphertext_length,
        u64::from(body.chunk_count),
    )?;
    let parent_id = validate_encrypted_parent(&state, &user, body.parent_id.as_deref()).await?;
    let migration_expected_size = if body.migration {
        if state.config.e2ee_mode != E2eeMode::Migrate || generation_number != 1 {
            return Err(error::ErrorBadRequest(
                "encrypted migration request is invalid",
            ));
        }
        let row = state
            .db
            .query_opt(
                "
                    SELECT files.parent_id, files.entry_type, files.size_bytes,
                           migrations.state
                    FROM files
                    INNER JOIN vault_migrations AS migrations
                      ON migrations.node_id = files.id AND migrations.owner_id = files.owner_id
                    WHERE files.id = $1 AND files.owner_id = $2
                      AND files.e2ee_state = 'staged'
                    LIMIT 1
                ",
                &[&body.node_id, &user.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
            .ok_or_else(|| error::ErrorConflict("legacy node is not claimed for migration"))?;
        if row.get::<_, String>("state") != "encrypting"
            || row.get::<_, String>("entry_type") != body.entry_type
            || row.get::<_, Option<String>>("parent_id") != parent_id
        {
            return Err(error::ErrorConflict("legacy node changed during migration"));
        }
        if body.entry_type == "file" {
            Some(row.get::<_, i64>("size_bytes"))
        } else {
            Some(0)
        }
    } else {
        None
    };

    if let Some(row) = state
        .db
        .query_opt(
            "
                SELECT id FROM vault_uploads
                WHERE owner_id = $1 AND node_id = $2
                  AND generation_number = $3 AND generation_id = $4
                  AND status IN ('initializing', 'pending', 'completing')
                  AND expires_at > now()
                LIMIT 1
            ",
            &[&user.id, &body.node_id, &generation_number, &generation_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
    {
        let upload_id: String = row.get("id");
        let upload = get_upload(&state, &user.id, &upload_id)
            .await?
            .ok_or_else(|| error::ErrorConflict("upload disappeared"))?;
        state.db.release_request_connection().await;
        let existing_parts = match (
            upload.object_key.as_deref(),
            upload.multipart_upload_id.as_deref(),
        ) {
            (Some(object_key), Some(multipart_id)) => state
                .storage
                .uploaded_parts(object_key, multipart_id)
                .await
                .map_err(error::ErrorBadGateway)?,
            _ => Vec::new(),
        };
        return Ok(HttpResponse::Ok().json(upload_plan(&upload, existing_parts)));
    }

    let upload_id = format!("vup_{}", random_id()?);
    let object_key = if body.entry_type == "file" {
        Some(format!(
            "users/{}/vault/{}/{}",
            user.id,
            body.node_id,
            random_id()?
        ))
    } else {
        None
    };
    let mode = if body.entry_type == "folder" {
        "none"
    } else if uses_vault_multipart_upload(body.ciphertext_length) {
        "multipart"
    } else {
        "single"
    };
    let part_size_bytes = (mode == "multipart").then_some(UPLOAD_PART_BYTES as i64);
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let upload_lock_key = format!("vault-upload:{}:{}", user.id, body.node_id);
    query_one_cached(
        &transaction,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&upload_lock_key],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    let existing_node = query_opt_cached(
        &transaction,
        "
            SELECT entry_type, size_bytes, e2ee_state
            FROM files
            WHERE id = $1 AND owner_id = $2 AND state = 'active'
            FOR UPDATE
        ",
        &[&body.node_id, &user.id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if let Some(existing_node) = existing_node.as_ref()
        && existing_node.get::<_, String>("entry_type") != body.entry_type
    {
        return Err(error::ErrorConflict("encrypted node type changed"));
    }
    if let Some(expected_size) = migration_expected_size
        && existing_node.as_ref().is_none_or(|node| {
            node.get::<_, String>("e2ee_state") != "staged"
                || node.get::<_, i64>("size_bytes") != expected_size
        })
    {
        return Err(error::ErrorConflict("legacy node changed during migration"));
    }
    let concurrent_upload = query_opt_cached(
        &transaction,
        "
            SELECT id FROM vault_uploads
            WHERE owner_id = $1 AND node_id = $2
              AND generation_number = $3 AND generation_id = $4
              AND status IN ('initializing', 'pending', 'completing')
            LIMIT 1
        ",
        &[&user.id, &body.node_id, &generation_number, &generation_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if let Some(row) = concurrent_upload {
        let existing_upload_id: String = row.get("id");
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        drop(client);
        state.db.release_request_connection().await;
        let upload = get_upload(&state, &user.id, &existing_upload_id)
            .await?
            .ok_or_else(|| error::ErrorConflict("upload disappeared"))?;
        state.db.release_request_connection().await;
        let existing_parts = match (
            upload.object_key.as_deref(),
            upload.multipart_upload_id.as_deref(),
        ) {
            (Some(existing_object_key), Some(multipart_id)) => state
                .storage
                .uploaded_parts(existing_object_key, multipart_id)
                .await
                .map_err(error::ErrorBadGateway)?,
            _ => Vec::new(),
        };
        return Ok(HttpResponse::Ok().json(upload_plan(&upload, existing_parts)));
    }
    let competing_upload = query_opt_cached(
        &transaction,
        "
            SELECT id FROM vault_uploads
            WHERE owner_id = $1 AND node_id = $2
              AND status IN ('initializing', 'pending', 'completing', 'aborting')
            LIMIT 1
        ",
        &[&user.id, &body.node_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if competing_upload.is_some() {
        return Err(error::ErrorConflict(
            "another encrypted generation is already uploading",
        ));
    }
    let replacement_credit = existing_node
        .as_ref()
        .filter(|node| node.get::<_, String>("entry_type") == "file")
        .map_or(0, |node| node.get::<_, i64>("size_bytes"));
    let reservation = reservation_amount(ciphertext_length, replacement_credit)?;
    reserve_upload_capacity(
        &transaction,
        &user.id,
        reservation,
        state.config.storage_quota_bytes,
    )
    .await?;
    transaction
        .execute(
            "
                INSERT INTO vault_uploads (
                  id, node_id, owner_id, parent_id, entry_type,
                  generation_number, generation_id, object_key,
                  ciphertext_length, chunk_count, upload_mode,
                  part_size_bytes, reservation_bytes, status, expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'initializing', now() + interval '24 hours')
            ",
            &[
                &upload_id,
                &body.node_id,
                &user.id,
                &parent_id,
                &body.entry_type,
                &generation_number,
                &generation_id,
                &object_key,
                &ciphertext_length,
                &chunk_count,
                &mode,
                &part_size_bytes,
                &reservation.ledger_bytes,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    state.db.release_request_connection().await;

    let prepared = if let Some(object_key) = object_key.as_deref() {
        match state
            .storage
            .prepare_vault_upload(object_key, body.ciphertext_length)
            .await
        {
            Ok(prepared) => Some(prepared),
            Err(storage_error) => {
                let _ = state
                    .db
                    .execute(
                        "UPDATE vault_uploads SET status = 'aborting' WHERE id = $1",
                        &[&upload_id],
                    )
                    .await;
                return Err(error::ErrorBadGateway(storage_error));
            }
        }
    } else {
        None
    };
    let prepared_mode = prepared.as_ref().map(|value| value.mode).unwrap_or("none");
    if prepared_mode != mode {
        return Err(error::ErrorInternalServerError(
            "storage returned an incompatible encrypted upload plan",
        ));
    }
    let multipart_upload_id = prepared
        .as_ref()
        .and_then(|value| value.multipart_upload_id.clone());
    state
        .db
        .execute(
            "UPDATE vault_uploads SET multipart_upload_id = $1, status = 'pending' WHERE id = $2 AND status = 'initializing'",
            &[&multipart_upload_id, &upload_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let upload = get_upload(&state, &user.id, &upload_id)
        .await?
        .ok_or_else(|| error::ErrorInternalServerError("upload was not persisted"))?;

    Ok(HttpResponse::Created().json(upload_plan(&upload, Vec::new())))
}

pub async fn presign_content(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ChecksumRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let upload = get_upload(&state, &user.id, &path.into_inner())
        .await?
        .ok_or_else(|| error::ErrorNotFound("upload not found"))?;
    if upload.mode != "single" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let checksum = validate_sha256_checksum(&body.checksum_sha256)?;
    let reserved = state
        .db
        .execute(
            "
                UPDATE vault_uploads
                SET checksum_sha256 = $1,
                    write_expires_at = now() + interval '1 hour'
                WHERE id = $2 AND owner_id = $3 AND status = 'pending'
                  AND (checksum_sha256 IS NULL OR checksum_sha256 = $1)
            ",
            &[&checksum, &upload.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if reserved != 1 {
        return Ok(HttpResponse::Conflict().body("upload checksum changed"));
    }
    let object_key = upload
        .object_key
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
    let content_length = u64::try_from(upload.ciphertext_length)
        .map_err(|_| error::ErrorInternalServerError("ciphertext length is invalid"))?;
    let url = state
        .storage
        .presign_single_upload(
            object_key,
            "application/octet-stream",
            &checksum,
            content_length,
        )
        .await
        .map_err(error::ErrorBadGateway)?;

    Ok(HttpResponse::Ok().json(UploadUrlResponse {
        url,
        content_length,
    }))
}

pub async fn presign_part(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, i32)>,
    body: web::Json<ChecksumRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let (upload_id, part_number) = path.into_inner();
    let upload = get_upload(&state, &user.id, &upload_id)
        .await?
        .ok_or_else(|| error::ErrorNotFound("upload not found"))?;
    if upload.mode != "multipart" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    let total = u64::try_from(upload.ciphertext_length)
        .map_err(|_| error::ErrorInternalServerError("ciphertext length is invalid"))?;
    let part_number_u64 = u64::try_from(part_number)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| error::ErrorBadRequest("part number is invalid"))?;
    let part_count = total.div_ceil(UPLOAD_PART_BYTES);
    if part_number_u64 > part_count {
        return Err(error::ErrorBadRequest("part number is invalid"));
    }
    let offset = (part_number_u64 - 1) * UPLOAD_PART_BYTES;
    let content_length = (total - offset).min(UPLOAD_PART_BYTES);
    let checksum = validate_sha256_checksum(&body.checksum_sha256)?;
    let object_key = upload
        .object_key
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
    let multipart_upload_id = upload
        .multipart_upload_id
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("multipart upload id is missing"))?;
    let url = state
        .storage
        .presign_upload_part(
            object_key,
            multipart_upload_id,
            part_number,
            &checksum,
            content_length,
        )
        .await
        .map_err(error::ErrorBadGateway)?;

    Ok(HttpResponse::Ok().json(UploadUrlResponse {
        url,
        content_length,
    }))
}

pub async fn presign_parts(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<PartChecksumsRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let principal = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let upload = get_upload(&state, &principal.id, &path.into_inner())
        .await?
        .ok_or_else(|| error::ErrorNotFound("upload not found"))?;
    if upload.mode != "multipart" || upload.status != "pending" {
        return Ok(HttpResponse::Conflict().finish());
    }
    if body.parts.is_empty() || body.parts.len() > MAX_PRESIGN_PARTS {
        return Err(error::ErrorBadRequest(
            "multipart presign batch must contain 1 to 32 parts",
        ));
    }

    let total = u64::try_from(upload.ciphertext_length)
        .map_err(|_| error::ErrorInternalServerError("ciphertext length is invalid"))?;
    let part_count = total.div_ceil(UPLOAD_PART_BYTES);
    let mut parts = body
        .parts
        .iter()
        .map(|part| {
            let part_number = u64::try_from(part.part_number)
                .ok()
                .filter(|value| *value > 0 && *value <= part_count)
                .ok_or_else(|| error::ErrorBadRequest("part number is invalid"))?;
            let offset = (part_number - 1)
                .checked_mul(UPLOAD_PART_BYTES)
                .ok_or_else(|| error::ErrorBadRequest("part number is invalid"))?;
            let content_length = total
                .checked_sub(offset)
                .map(|remaining| remaining.min(UPLOAD_PART_BYTES))
                .filter(|length| *length > 0)
                .ok_or_else(|| error::ErrorBadRequest("part number is invalid"))?;
            Ok((
                part.part_number,
                validate_sha256_checksum(&part.checksum_sha256)?,
                content_length,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    parts.sort_by_key(|(part_number, _, _)| *part_number);
    if parts.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(error::ErrorBadRequest("upload part is duplicated"));
    }
    let object_key = upload
        .object_key
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
    let multipart_upload_id = upload
        .multipart_upload_id
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("multipart upload id is missing"))?;
    let urls = try_join_all(parts.iter().map(|(part_number, checksum, length)| {
        state.storage.presign_upload_part(
            object_key,
            multipart_upload_id,
            *part_number,
            checksum,
            *length,
        )
    }))
    .await
    .map_err(error::ErrorBadGateway)?;
    let parts = parts
        .into_iter()
        .zip(urls)
        .map(|((part_number, _, content_length), url)| PartUrlResponse {
            part_number,
            url,
            content_length,
        })
        .collect();

    Ok(HttpResponse::Ok().json(PartUrlsResponse { parts }))
}

pub async fn publish_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<PublishUploadRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let upload = get_upload(&state, &user.id, &path.into_inner())
        .await?
        .ok_or_else(|| error::ErrorNotFound("upload not found"))?;
    if upload.status == "published" {
        return current_publish_response(&state, &user, &upload.node_id).await;
    }
    if !matches!(upload.status.as_str(), "pending" | "completing") {
        return Ok(HttpResponse::Conflict().body("upload cannot be published"));
    }

    let decoded = decode_and_verify_node_record(&state, &user, &body).await?;
    validate_record_for_upload(&decoded, &upload)?;
    let completed_parts = validate_completed_parts(&upload, &body.parts)?;
    let metadata = finalize_ciphertext_object(&state, &user, &upload, &completed_parts).await?;
    let response =
        publish_record_transaction(&state, &user, &upload, &decoded, metadata.as_ref()).await?;

    Ok(HttpResponse::Created().json(response))
}

pub async fn publish_record(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<PublishRecordRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let upload_body = PublishUploadRequest {
        parts: Vec::new(),
        bootstrap_cbor: body.bootstrap_cbor.clone(),
        bootstrap_signature: body.bootstrap_signature.clone(),
        encrypted_manifest: body.encrypted_manifest.clone(),
        wrappers: body.wrappers.clone(),
    };
    let decoded = decode_and_verify_node_record(&state, &user, &upload_body).await?;
    let node_id = path.into_inner();
    if decoded.verified.bootstrap.node_id != node_id {
        return Err(error::ErrorBadRequest("node record targets another node"));
    }

    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let file = transaction
        .query_opt(
            "
                SELECT owner_id, parent_id, current_generation_number,
                       current_generation_id, size_bytes, entry_type
                FROM files
                WHERE id = $1 AND owner_id = $2 AND e2ee_state = 'encrypted'
                FOR UPDATE
            ",
            &[&node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(file) = file else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let head = transaction
        .query_one(
            "SELECT record_version, record_hash FROM vault_node_heads WHERE node_id = $1 FOR UPDATE",
            &[&node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    validate_head_cas(
        head.get("record_version"),
        head.get::<_, Vec<u8>>("record_hash").as_slice(),
        &decoded.verified.bootstrap,
    )?;
    let current_generation_number: i64 = file.get("current_generation_number");
    let current_generation_id: Vec<u8> = file.get("current_generation_id");
    if decoded.verified.bootstrap.generation_number != current_generation_number as u64
        || decoded.verified.bootstrap.generation_id.as_slice() != current_generation_id
        || decoded.verified.bootstrap.ciphertext_length != file.get::<_, i64>("size_bytes") as u64
    {
        return Err(error::ErrorConflict(
            "node generation changed; regenerate the record",
        ));
    }
    reject_fenced_share_write(&transaction, &node_id, None, &user.id).await?;
    validate_owner_wrappers(
        &decoded,
        file.get::<_, Option<String>>("parent_id").as_deref(),
    )?;
    let (committed_share_wrappers, share_sync_required) = publication_share_wrappers(
        &transaction,
        &decoded,
        &node_id,
        file.get::<_, Option<String>>("parent_id").as_deref(),
        &user.id,
        false,
    )
    .await?;
    insert_node_record(&transaction, &user.id, &decoded).await?;
    update_share_sync_job(
        &transaction,
        &node_id,
        &user.id,
        i64::try_from(decoded.verified.bootstrap.record_version)
            .map_err(|_| error::ErrorBadRequest("record version is invalid"))?,
        share_sync_required,
    )
    .await?;
    replace_owner_wrappers(&transaction, &user.id, &decoded).await?;
    insert_share_wrappers(&transaction, &committed_share_wrappers, None).await?;
    update_node_head(&transaction, &user.id, &decoded).await?;
    transaction
        .execute(
            "UPDATE files SET updated_at = now() WHERE id = $1",
            &[&node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(PublishResponse {
        node_id,
        generation_number: current_generation_number,
        generation_id: encode_bytes(current_generation_id),
        record_version: decoded.verified.bootstrap.record_version as i64,
        record_hash: encode_bytes(decoded.verified.record_hash),
        share_sync_required,
    }))
}

pub async fn download_plan(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let node_id = path.into_inner();
    let row = state
        .db
        .query_opt(
            "
                SELECT files.owner_id, files.entry_type,
                       files.current_generation_number,
                       files.current_generation_id,
                       records.bootstrap_cbor, records.bootstrap_signature,
                       records.encrypted_manifest, records.signer_key_version,
                       heads.record_version, heads.record_hash,
                       identity.ed25519_public_key,
                       generations.object_key, generations.ciphertext_length,
                       generations.crypto_chunk_bytes, generations.chunk_count,
                       generations.ciphertext_merkle_root
                FROM files
                INNER JOIN vault_node_heads AS heads ON heads.node_id = files.id
                INNER JOIN vault_node_records AS records
                  ON records.node_id = heads.node_id
                 AND records.record_version = heads.record_version
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = records.owner_id
                 AND identity.key_version = records.signer_key_version
                LEFT JOIN vault_object_generations AS generations
                  ON generations.node_id = files.id
                 AND generations.generation_number = files.current_generation_number
                 AND generations.status = 'published'
                WHERE files.id = $1 AND files.owner_id = $2
                  AND files.e2ee_state = 'encrypted'
                  AND files.state = 'active'
                LIMIT 1
            ",
            &[&node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return shared_download_plan(&state, &user, &node_id).await;
    };
    let record_version: i64 = row.get("record_version");
    let wrappers = state
        .db
        .query(
            "SELECT canonical_cbor FROM vault_wrappers WHERE node_id = $1 AND record_version = $2 ORDER BY wrapper_id",
            &[&node_id, &record_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| encode_bytes(row.get::<_, Vec<u8>>("canonical_cbor")))
        .collect::<Vec<_>>();
    let object_key: Option<String> = row.get("object_key");
    let download_url = if let Some(object_key) = object_key.as_deref() {
        state
            .storage
            .download_url(object_key, "aeralyth-ciphertext.bin")
            .await
            .map_err(error::ErrorBadGateway)?
    } else {
        None
    };
    let bootstrap_cbor: Vec<u8> = row.get("bootstrap_cbor");
    let bootstrap = decode_bootstrap(&bootstrap_cbor).map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(DownloadPlanResponse {
        node_id,
        entry_type: row.get("entry_type"),
        generation_number: row.get("current_generation_number"),
        generation_id: encode_bytes(row.get::<_, Vec<u8>>("current_generation_id")),
        ciphertext_length: row.get::<_, Option<i64>>("ciphertext_length").unwrap_or(0),
        crypto_chunk_bytes: row
            .get::<_, Option<i32>>("crypto_chunk_bytes")
            .unwrap_or(CRYPTO_CHUNK_BYTES as i32),
        chunk_count: row.get::<_, Option<i32>>("chunk_count").unwrap_or(0),
        ciphertext_merkle_root: encode_bytes(
            row.get::<_, Option<Vec<u8>>>("ciphertext_merkle_root")
                .unwrap_or_else(|| bootstrap.ciphertext_merkle_root.to_vec()),
        ),
        download_url,
        bootstrap_cbor: encode_bytes(bootstrap_cbor),
        bootstrap_signature: encode_bytes(row.get::<_, Vec<u8>>("bootstrap_signature")),
        encrypted_manifest: encode_bytes(row.get::<_, Vec<u8>>("encrypted_manifest")),
        wrappers,
        signer_key_version: row.get("signer_key_version"),
        signer_ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
        record_version,
        record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
        share: None,
    }))
}

pub async fn abort_upload(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let Some(upload) = get_upload(&state, &user.id, &path.into_inner()).await? else {
        return Ok(HttpResponse::NoContent().finish());
    };
    if upload.status == "published" {
        return Ok(HttpResponse::Conflict().body("published uploads cannot be aborted"));
    }
    state
        .db
        .execute(
            "UPDATE vault_uploads SET status = 'aborting' WHERE id = $1 AND owner_id = $2 AND status <> 'published'",
            &[&upload.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if let (Some(object_key), Some(multipart_upload_id)) = (
        upload.object_key.as_deref(),
        upload.multipart_upload_id.as_deref(),
    ) {
        state
            .storage
            .abort_multipart(object_key, multipart_upload_id)
            .await
            .map_err(error::ErrorBadGateway)?;
    }
    if let Some(object_key) = upload.object_key.as_deref() {
        state
            .storage
            .delete_object(object_key)
            .await
            .map_err(error::ErrorBadGateway)?;
    }
    state
        .db
        .execute(
            "UPDATE vault_uploads SET status = 'aborted' WHERE id = $1 AND owner_id = $2",
            &[&upload.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::NoContent().finish())
}

pub async fn share_plan(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let node_id = path.into_inner();
    validate_node_id(&node_id)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let snapshot = subtree_snapshot(&transaction, &node_id, &user.id).await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(SharePreparationResponse {
        nodes: snapshot.into_iter().map(snapshot_response).collect(),
    }))
}

pub async fn share_contexts(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let node_id = path.into_inner();
    validate_node_id(&node_id)?;
    let rows = state
        .db
        .query(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, parent_id FROM files
                  WHERE id = $1 AND owner_id = $2 AND e2ee_state = 'encrypted'
                  UNION ALL
                  SELECT parent.id, parent.parent_id
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2 AND parent.e2ee_state = 'encrypted'
                )
                SELECT shares.id, shares.active_epoch,
                       owner_keys.wrapper_id, owner_keys.root_ciphertext
                FROM vault_shares AS shares
                INNER JOIN ancestors ON ancestors.id = shares.root_node_id
                INNER JOIN vault_share_owner_keys AS owner_keys
                  ON owner_keys.share_id = shares.id
                 AND owner_keys.epoch = shares.active_epoch
                WHERE shares.owner_id = $2 AND shares.status = 'active'
                  AND shares.publication_fenced = FALSE
                ORDER BY shares.id
            ",
            &[&node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let contexts = rows
        .into_iter()
        .map(|row| ActiveShareContextResponse {
            share_id: row.get("id"),
            epoch: row.get("active_epoch"),
            wrapper_id: encode_bytes(row.get::<_, Vec<u8>>("wrapper_id")),
            ciphertext: encode_bytes(row.get::<_, Vec<u8>>("root_ciphertext")),
        })
        .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(contexts))
}

pub async fn share_sync_jobs(
    state: web::Data<AppState>,
    request: HttpRequest,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let principal = require_principal(&state, &request).await?;
    let rows = state
        .db
        .query(
            "
                SELECT jobs.node_id, files.entry_type,
                       files.current_generation_number,
                       files.current_generation_id,
                       heads.record_version, heads.record_hash
                FROM vault_share_sync_jobs AS jobs
                INNER JOIN files ON files.id = jobs.node_id
                INNER JOIN vault_node_heads AS heads
                  ON heads.node_id = jobs.node_id
                 AND heads.record_version = jobs.record_version
                WHERE jobs.owner_id = $1
                  AND files.owner_id = $1
                  AND files.e2ee_state = 'encrypted'
                  AND files.state = 'active'
                ORDER BY jobs.updated_at, jobs.node_id
                LIMIT 32
            ",
            &[&principal.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let jobs = rows
        .into_iter()
        .map(|row| ShareSyncJobResponse {
            node_id: row.get("node_id"),
            entry_type: row.get("entry_type"),
            generation_number: row.get("current_generation_number"),
            generation_id: encode_bytes(row.get::<_, Vec<u8>>("current_generation_id")),
            record_version: row.get("record_version"),
            record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
        })
        .collect();
    Ok(HttpResponse::Ok().json(ShareSyncJobsResponse { jobs }))
}

pub async fn publish_share_directory(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<PublishShareDirectoryRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let principal = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let node_id = path.into_inner();
    validate_node_id(&node_id)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &principal.id).await?;
    let job = transaction
        .query_opt(
            "
                SELECT jobs.record_version, files.entry_type,
                       files.current_generation_number,
                       files.current_generation_id,
                       heads.record_hash, records.signer_key_version,
                       identity.ed25519_public_key
                FROM vault_share_sync_jobs AS jobs
                INNER JOIN files ON files.id = jobs.node_id
                INNER JOIN vault_node_heads AS heads
                  ON heads.node_id = jobs.node_id
                 AND heads.record_version = jobs.record_version
                INNER JOIN vault_node_records AS records
                  ON records.node_id = heads.node_id
                 AND records.record_version = heads.record_version
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = records.owner_id
                 AND identity.key_version = records.signer_key_version
                WHERE jobs.node_id = $1 AND jobs.owner_id = $2
                  AND files.owner_id = $2
                FOR UPDATE OF jobs
            ",
            &[&node_id, &principal.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(job) = job else {
        return Ok(HttpResponse::NoContent().finish());
    };
    let shares = transaction
        .query(
            "
                WITH RECURSIVE ancestors AS (
                  SELECT id, parent_id FROM files
                  WHERE id = $1 AND owner_id = $2
                  UNION ALL
                  SELECT parent.id, parent.parent_id
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2
                )
                SELECT shares.id, shares.active_epoch
                FROM vault_shares AS shares
                INNER JOIN ancestors ON ancestors.id = shares.root_node_id
                WHERE shares.owner_id = $2 AND shares.status = 'active'
                  AND shares.publication_fenced = FALSE
                ORDER BY shares.id
                FOR SHARE OF shares
            ",
            &[&node_id, &principal.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if shares.is_empty() {
        if body.directory_cbor.is_some()
            || body.directory_signature.is_some()
            || !body.wrappers.is_empty()
        {
            return Err(error::ErrorConflict(
                "active shares changed; refresh the share directory",
            ));
        }
        transaction
            .execute(
                "DELETE FROM vault_share_sync_jobs WHERE node_id = $1 AND owner_id = $2",
                &[&node_id, &principal.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        return Ok(HttpResponse::NoContent().finish());
    }

    let directory_cbor = decode_limited(
        body.directory_cbor
            .as_deref()
            .ok_or_else(|| error::ErrorBadRequest("share directory is required"))?,
        4_096,
        "share directory",
    )?;
    let directory_signature = decode_fixed::<64>(
        body.directory_signature
            .as_deref()
            .ok_or_else(|| error::ErrorBadRequest("share directory signature is required"))?,
        "share directory signature",
    )?;
    let directory = decode_share_directory(&directory_cbor).map_err(error::ErrorBadRequest)?;
    let record_version: i64 = job.get("record_version");
    let generation_number: i64 = job.get("current_generation_number");
    let generation_id: Vec<u8> = job.get("current_generation_id");
    let record_hash: Vec<u8> = job.get("record_hash");
    let signer_key_version: i64 = job.get("signer_key_version");
    if directory.format_version != SHARE_DIRECTORY_VERSION
        || directory.node_id != node_id
        || i64::try_from(directory.record_version).ok() != Some(record_version)
        || directory.record_hash.as_slice() != record_hash
        || i64::try_from(directory.generation_number).ok() != Some(generation_number)
        || directory.generation_id.as_slice() != generation_id
        || i64::try_from(directory.signer_key_version).ok() != Some(signer_key_version)
    {
        return Err(error::ErrorConflict(
            "share directory targets a stale node record",
        ));
    }
    verify_ed25519_signature(
        &directory_cbor,
        &directory_signature,
        job.get::<_, Vec<u8>>("ed25519_public_key").as_slice(),
    )
    .map_err(error::ErrorBadRequest)?;

    let include_generation = job.get::<_, String>("entry_type") == "file";
    let expected_count = shares
        .len()
        .checked_mul(if include_generation { 2 } else { 1 })
        .ok_or_else(|| error::ErrorBadRequest("share wrapper count is invalid"))?;
    if body.wrappers.len() != expected_count || body.wrappers.len() > 8_192 {
        return Err(error::ErrorConflict(
            "active shares changed; refresh the share directory",
        ));
    }
    let mut expected = HashSet::with_capacity(expected_count);
    for share in shares {
        let share_id: String = share.get("id");
        let epoch: i64 = share.get("active_epoch");
        expected.insert((share_id.clone(), epoch, 4_u64, None));
        if include_generation {
            expected.insert((share_id, epoch, 3_u64, Some(generation_id.clone())));
        }
    }
    let mut actual = HashSet::with_capacity(expected_count);
    let mut material = Vec::with_capacity(expected_count);
    for encoded in &body.wrappers {
        let canonical = decode_limited(encoded, 65_536, "share wrapper")?;
        let record = decode_wrapper(&canonical).map_err(error::ErrorBadRequest)?;
        if !matches!(record.kind, 3 | 4)
            || record.node_id != node_id
            || i64::try_from(record.record_version).ok() != Some(record_version)
        {
            return Err(error::ErrorBadRequest(
                "share wrapper targets another node record",
            ));
        }
        let share_id = record.share_id.clone().unwrap_or_default();
        let epoch = i64::try_from(record.epoch.unwrap_or_default())
            .map_err(|_| error::ErrorBadRequest("share epoch is invalid"))?;
        let wrapper_generation_id = record.generation_id.map(Vec::from);
        if !actual.insert((share_id, epoch, record.kind, wrapper_generation_id)) {
            return Err(error::ErrorBadRequest("share wrapper is duplicated"));
        }
        material.push(ShareWrapperMaterial {
            hash: sha256(&canonical),
            canonical,
            record,
        });
    }
    if actual != expected {
        return Err(error::ErrorConflict(
            "active shares changed; refresh the share directory",
        ));
    }
    let hashes = material.iter().map(|value| value.hash).collect::<Vec<_>>();
    let commitment = wrapper_set_commitment(&hashes).map_err(error::ErrorBadRequest)?;
    if directory.wrapper_set_root != commitment.root
        || i32::try_from(directory.wrapper_count).ok() != Some(commitment.count)
    {
        return Err(error::ErrorBadRequest(
            "share directory commitment does not match its wrappers",
        ));
    }
    transaction
        .execute(
            "
                DELETE FROM vault_share_wrappers AS wrappers
                USING vault_shares AS shares
                WHERE wrappers.share_id = shares.id
                  AND shares.owner_id = $1
                  AND wrappers.node_id = $2
            ",
            &[&principal.id, &node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    insert_share_wrappers(&transaction, &material, Some((&commitment, "directory"))).await?;
    transaction
        .execute(
            "
                INSERT INTO vault_share_wrapper_directories (
                  node_id, record_version, owner_id, signer_key_version,
                  canonical_cbor, signature, wrapper_set_root, wrapper_count
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (node_id, record_version) DO UPDATE SET
                  canonical_cbor = EXCLUDED.canonical_cbor,
                  signature = EXCLUDED.signature,
                  wrapper_set_root = EXCLUDED.wrapper_set_root,
                  wrapper_count = EXCLUDED.wrapper_count
            ",
            &[
                &node_id,
                &record_version,
                &principal.id,
                &signer_key_version,
                &directory_cbor,
                &directory_signature.as_slice(),
                &commitment.root.as_slice(),
                &commitment.count,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "DELETE FROM vault_share_sync_jobs WHERE node_id = $1 AND owner_id = $2",
            &[&node_id, &principal.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(HttpResponse::NoContent().finish())
}

pub async fn create_share(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<CreateShareRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    validate_prefixed_id(&body.share_id, "shr_", "share id")?;
    validate_node_id(&body.root_node_id)?;
    if body.recipient_id == user.id {
        return Err(error::ErrorBadRequest(
            "a vault cannot be shared with its owner",
        ));
    }
    let recipient_key_version = i64::try_from(body.recipient_key_version)
        .map_err(|_| error::ErrorBadRequest("recipient key version is invalid"))?;
    let owner_epoch_key = validate_owner_epoch_key(&body.owner_epoch_key)?;
    let trusted = state
        .db
        .query_opt(
            "
                SELECT 1
                FROM vault_identity_trust AS trust
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = trust.peer_user_id
                 AND identity.key_version = trust.peer_key_version
                 AND identity.status = 'active'
                WHERE trust.user_id = $1 AND trust.peer_user_id = $2
                  AND trust.peer_key_version = $3 AND trust.status = 'accepted'
            ",
            &[&user.id, &body.recipient_id, &recipient_key_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if trusted.is_none() {
        return Err(error::ErrorPreconditionFailed(
            "confirm the recipient identity fingerprint before sharing",
        ));
    }

    let sender_identity = active_identity(&state, &user.id).await?;
    let wrappers = decode_share_wrappers(&body.wrappers, &body.share_id, 1)?;
    let envelopes = decode_share_envelopes(&body.envelopes, &sender_identity.ed25519_public_key)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let root = transaction
        .query_opt(
            "SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND e2ee_state = 'encrypted' AND state = 'active' FOR UPDATE",
            &[&body.root_node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if root.is_none() {
        return Ok(HttpResponse::NotFound().body("encrypted share root not found"));
    }
    let snapshot = subtree_snapshot(&transaction, &body.root_node_id, &user.id).await?;
    let wrapper_commitment = validate_share_material(
        &wrappers,
        &envelopes,
        &snapshot,
        &body.share_id,
        1,
        &user.id,
        sender_identity.key_version,
        &body.recipient_id,
        recipient_key_version,
        &body.root_node_id,
        1,
        None,
    )?;
    let snapshot_hash = snapshot_hash(&snapshot);
    let share_hash = share_record_hash(&snapshot_hash, &wrapper_commitment, &envelopes, 1);
    transaction
        .execute(
            "
                INSERT INTO vault_shares (
                  id, owner_id, root_node_id, active_epoch, status,
                  record_version, record_hash
                )
                VALUES ($1, $2, $3, 1, 'active', 1, $4)
            ",
            &[
                &body.share_id,
                &user.id,
                &body.root_node_id,
                &share_hash.as_slice(),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "INSERT INTO vault_share_epochs (share_id, epoch, status, protocol_version, wrapper_set_root, wrapper_count, published_at) VALUES ($1, 1, 'published', $2, $3, $4, now())",
            &[
                &body.share_id,
                &(SHARE_ENVELOPE_VERSION as i16),
                &wrapper_commitment.root.as_slice(),
                &wrapper_commitment.count,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    insert_owner_epoch_key(&transaction, &body.share_id, 1, &owner_epoch_key).await?;
    transaction
        .execute(
            "
                INSERT INTO vault_share_recipients (
                  share_id, recipient_id, recipient_key_version, status
                ) VALUES ($1, $2, $3, 'active')
            ",
            &[&body.share_id, &body.recipient_id, &recipient_key_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    insert_share_wrappers(
        &transaction,
        &wrappers,
        Some((&wrapper_commitment, "epoch")),
    )
    .await?;
    insert_share_envelopes(&transaction, &envelopes).await?;
    transaction
        .execute(
            "
                INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
                VALUES (gen_random_uuid()::text, $1, $2, $3)
                ON CONFLICT (file_id, recipient_id) DO NOTHING
            ",
            &[&body.root_node_id, &user.id, &body.recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Created().json(ShareMutationResponse {
        share_id: body.share_id.clone(),
        active_epoch: 1,
        record_hash: encode_bytes(share_hash),
        limitation: "Revocation prevents future access only; it cannot erase keys or plaintext already obtained by a recipient.",
    }))
}

pub async fn list_shares(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let rows = state
        .db
        .query(
            "
                SELECT shares.id, shares.root_node_id, shares.active_epoch,
                       shares.pending_epoch,
                       shares.status, recipients.recipient_id,
                       recipients.recipient_key_version, users.username,
                       pending.recipient_id AS pending_revoked_recipient_id
                FROM vault_shares AS shares
                LEFT JOIN vault_share_recipients AS recipients
                  ON recipients.share_id = shares.id AND recipients.status = 'active'
                LEFT JOIN users ON users.id = recipients.recipient_id
                LEFT JOIN vault_share_pending_revocations AS pending
                  ON pending.share_id = shares.id
                 AND pending.pending_epoch = shares.pending_epoch
                WHERE shares.owner_id = $1 AND shares.status IN ('active', 'rotating')
                ORDER BY shares.created_at, shares.id, recipients.joined_at
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let mut shares = Vec::<OwnedShareResponse>::new();
    for row in rows {
        let share_id: String = row.get("id");
        if shares.last().map(|share| share.share_id.as_str()) != Some(share_id.as_str()) {
            shares.push(OwnedShareResponse {
                share_id: share_id.clone(),
                root_node_id: row.get("root_node_id"),
                active_epoch: row.get("active_epoch"),
                pending_epoch: row.get("pending_epoch"),
                pending_revoked_recipient_id: row.get("pending_revoked_recipient_id"),
                status: row.get("status"),
                recipients: Vec::new(),
            });
        }
        if let (Some(user_id), Some(username), Some(key_version)) = (
            row.get::<_, Option<String>>("recipient_id"),
            row.get::<_, Option<String>>("username"),
            row.get::<_, Option<i64>>("recipient_key_version"),
        ) && let Some(share) = shares.last_mut()
        {
            share.recipients.push(OwnedShareRecipient {
                user_id,
                username,
                key_version,
            });
        }
    }

    Ok(HttpResponse::Ok().json(shares))
}

pub async fn pending_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let share_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let share = transaction
        .query_opt(
            "
                SELECT shares.root_node_id, shares.pending_epoch,
                       shares.fence_snapshot_hash, shares.record_version,
                       shares.record_hash, pending.recipient_id AS revoked_recipient_id
                FROM vault_shares AS shares
                INNER JOIN vault_share_pending_revocations AS pending
                  ON pending.share_id = shares.id
                 AND pending.pending_epoch = shares.pending_epoch
                WHERE shares.id = $1 AND shares.owner_id = $2
                  AND shares.status = 'rotating'
                  AND shares.publication_fenced = TRUE
                FOR SHARE OF shares
            ",
            &[&share_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(share) = share else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let root_node_id: String = share.get("root_node_id");
    let pending_epoch: i64 = share
        .get::<_, Option<i64>>("pending_epoch")
        .ok_or_else(|| error::ErrorConflict("pending share epoch is missing"))?;
    let expected_snapshot_hash: Vec<u8> = share
        .get::<_, Option<Vec<u8>>>("fence_snapshot_hash")
        .ok_or_else(|| error::ErrorConflict("share rotation fence is missing"))?;
    let snapshot = subtree_snapshot(&transaction, &root_node_id, &user.id).await?;
    let actual_snapshot_hash = snapshot_hash(&snapshot);
    if expected_snapshot_hash.as_slice() != actual_snapshot_hash {
        return Err(error::ErrorConflict(
            "shared subtree changed; cancel this pending rotation and start again",
        ));
    }
    let revoked_recipient_id: String = share.get("revoked_recipient_id");
    let current_record_version: i64 = share.get("record_version");
    let previous_record_hash = share
        .get::<_, Option<Vec<u8>>>("record_hash")
        .unwrap_or_default();
    let plan = build_epoch_rotation_plan(
        &transaction,
        &share_id,
        pending_epoch,
        actual_snapshot_hash,
        snapshot,
        &revoked_recipient_id,
        current_record_version,
        previous_record_hash,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(plan))
}

pub async fn begin_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BeginEpochRotationRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let share_id = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let share = transaction
        .query_opt(
            "
                SELECT root_node_id, active_epoch, record_version, record_hash,
                       status, publication_fenced
                FROM vault_shares
                WHERE id = $1 AND owner_id = $2
                FOR UPDATE
            ",
            &[&share_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(share) = share else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if share.get::<_, String>("status") != "active" || share.get::<_, bool>("publication_fenced") {
        return Ok(HttpResponse::Conflict().body("share is already rotating or revoked"));
    }
    let recipient = transaction
        .query_opt(
            "SELECT 1 FROM vault_share_recipients WHERE share_id = $1 AND recipient_id = $2 AND status = 'active' FOR UPDATE",
            &[&share_id, &body.revoked_recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if recipient.is_none() {
        return Err(error::ErrorBadRequest("active share recipient not found"));
    }
    let active_epoch: i64 = share.get("active_epoch");
    let pending_epoch = active_epoch
        .checked_add(1)
        .ok_or_else(|| error::ErrorInternalServerError("share epoch exhausted"))?;
    let root_node_id: String = share.get("root_node_id");
    transaction
        .execute(
            "
                UPDATE vault_shares
                SET pending_epoch = $1, publication_fenced = TRUE,
                    status = 'rotating', updated_at = now()
                WHERE id = $2
            ",
            &[&pending_epoch, &share_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "INSERT INTO vault_share_epochs (share_id, epoch, status) VALUES ($1, $2, 'pending')",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                INSERT INTO vault_share_pending_revocations (
                  share_id, pending_epoch, recipient_id
                ) VALUES ($1, $2, $3)
            ",
            &[&share_id, &pending_epoch, &body.revoked_recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let snapshot = subtree_snapshot(&transaction, &root_node_id, &user.id).await?;
    let fence_snapshot_hash = snapshot_hash(&snapshot);
    transaction
        .execute(
            "UPDATE vault_shares SET fence_snapshot_hash = $1 WHERE id = $2",
            &[&fence_snapshot_hash.as_slice(), &share_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let current_record_version: i64 = share.get("record_version");
    let previous_record_hash: Vec<u8> = share
        .get::<_, Option<Vec<u8>>>("record_hash")
        .unwrap_or_default();
    let plan = build_epoch_rotation_plan(
        &transaction,
        &share_id,
        pending_epoch,
        fence_snapshot_hash,
        snapshot,
        &body.revoked_recipient_id,
        current_record_version,
        previous_record_hash,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Created().json(plan))
}

#[allow(clippy::too_many_arguments)]
async fn build_epoch_rotation_plan(
    transaction: &tokio_postgres::Transaction<'_>,
    share_id: &str,
    pending_epoch: i64,
    fence_snapshot_hash: [u8; 32],
    snapshot: Vec<SnapshotNode>,
    revoked_recipient_id: &str,
    current_record_version: i64,
    previous_record_hash: Vec<u8>,
) -> Result<EpochRotationPlanResponse> {
    let recipient_rows = transaction
        .query(
            "
                SELECT recipients.recipient_id, recipients.recipient_key_version,
                       identity.x25519_public_key, identity.ed25519_public_key,
                       identity.fingerprint_sha256
                FROM vault_share_recipients AS recipients
                INNER JOIN vault_identity_keys AS identity
                  ON identity.user_id = recipients.recipient_id
                 AND identity.key_version = recipients.recipient_key_version
                 AND identity.status = 'active'
                WHERE recipients.share_id = $1 AND recipients.status = 'active'
                  AND recipients.recipient_id <> $2
                ORDER BY recipients.recipient_id
            ",
            &[&share_id, &revoked_recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let retained_recipients = recipient_rows
        .into_iter()
        .map(|row| EpochRecipient {
            user_id: row.get("recipient_id"),
            key_version: row.get("recipient_key_version"),
            x25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("x25519_public_key")),
            ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
            fingerprint_sha256: encode_bytes(row.get::<_, Vec<u8>>("fingerprint_sha256")),
        })
        .collect::<Vec<_>>();

    Ok(EpochRotationPlanResponse {
        share_id: share_id.to_owned(),
        pending_epoch,
        fence_snapshot_hash: encode_bytes(fence_snapshot_hash),
        nodes: snapshot.into_iter().map(snapshot_response).collect(),
        retained_recipients,
        record_version: current_record_version + 1,
        previous_record_hash: encode_bytes(previous_record_hash),
    })
}

pub async fn publish_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, i64)>,
    body: web::Json<PublishEpochRequest>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let (share_id, pending_epoch) = path.into_inner();
    let requested_snapshot_hash =
        decode_fixed::<32>(&body.fence_snapshot_hash, "fence snapshot hash")?;
    let owner_epoch_key = validate_owner_epoch_key(&body.owner_epoch_key)?;
    let sender_identity = active_identity(&state, &user.id).await?;
    let wrappers = decode_share_wrappers(&body.wrappers, &share_id, pending_epoch)?;
    let envelopes = decode_share_envelopes(&body.envelopes, &sender_identity.ed25519_public_key)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let share = transaction
        .query_opt(
            "
                SELECT root_node_id, active_epoch, pending_epoch,
                       publication_fenced, fence_snapshot_hash,
                       record_version, record_hash
                FROM vault_shares
                WHERE id = $1 AND owner_id = $2 AND status = 'rotating'
                FOR UPDATE
            ",
            &[&share_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(share) = share else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if share.get::<_, Option<i64>>("pending_epoch") != Some(pending_epoch)
        || !share.get::<_, bool>("publication_fenced")
        || share
            .get::<_, Option<Vec<u8>>>("fence_snapshot_hash")
            .as_deref()
            != Some(requested_snapshot_hash.as_slice())
    {
        return Err(error::ErrorConflict("share rotation fence changed"));
    }
    let root_node_id: String = share.get("root_node_id");
    let snapshot = subtree_snapshot(&transaction, &root_node_id, &user.id).await?;
    if snapshot_hash(&snapshot) != requested_snapshot_hash {
        return Err(error::ErrorConflict(
            "shared subtree changed; discard this epoch material and regenerate it",
        ));
    }
    let revoked = transaction
        .query_one(
            "SELECT recipient_id FROM vault_share_pending_revocations WHERE share_id = $1 AND pending_epoch = $2",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .get::<_, String>("recipient_id");
    let retained_rows = transaction
        .query(
            "
                SELECT recipient_id, recipient_key_version
                FROM vault_share_recipients
                WHERE share_id = $1 AND status = 'active' AND recipient_id <> $2
                ORDER BY recipient_id
            ",
            &[&share_id, &revoked],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let retained = retained_rows
        .iter()
        .map(|row| {
            (
                row.get::<_, String>("recipient_id"),
                row.get::<_, i64>("recipient_key_version"),
            )
        })
        .collect::<Vec<_>>();
    let next_record_version = share.get::<_, i64>("record_version") + 1;
    let previous_record_hash: Option<Vec<u8>> = share.get("record_hash");
    let wrapper_commitment = validate_rotation_material(
        &wrappers,
        &envelopes,
        &snapshot,
        &share_id,
        pending_epoch,
        &user.id,
        sender_identity.key_version,
        &retained,
        &root_node_id,
        next_record_version,
        previous_record_hash.as_deref(),
    )?;
    insert_owner_epoch_key(&transaction, &share_id, pending_epoch, &owner_epoch_key).await?;
    insert_share_wrappers(
        &transaction,
        &wrappers,
        Some((&wrapper_commitment, "epoch")),
    )
    .await?;
    insert_share_envelopes(&transaction, &envelopes).await?;
    let cutoff_hash = share_record_hash(
        &requested_snapshot_hash,
        &wrapper_commitment,
        &envelopes,
        pending_epoch,
    );
    let active_epoch: i64 = share.get("active_epoch");
    transaction
        .execute(
            "UPDATE vault_share_epochs SET status = 'retired', retired_at = now() WHERE share_id = $1 AND epoch = $2",
            &[&share_id, &active_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "UPDATE vault_share_epochs SET status = 'published', protocol_version = $3, wrapper_set_root = $4, wrapper_count = $5, published_at = now() WHERE share_id = $1 AND epoch = $2 AND status = 'pending'",
            &[
                &share_id,
                &pending_epoch,
                &(SHARE_ENVELOPE_VERSION as i16),
                &wrapper_commitment.root.as_slice(),
                &wrapper_commitment.count,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "UPDATE vault_share_recipients SET status = 'revoked', revoked_at = now() WHERE share_id = $1 AND recipient_id = $2",
            &[&share_id, &revoked],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "DELETE FROM file_shares WHERE file_id = $1 AND recipient_id = $2",
            &[&root_node_id, &revoked],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                INSERT INTO vault_revocation_cutoffs (
                  share_id, retired_epoch, published_epoch,
                  cutoff_record_version, cutoff_record_hash,
                  revoked_recipient_id
                ) VALUES ($1, $2, $3, $4, $5, $6)
            ",
            &[
                &share_id,
                &active_epoch,
                &pending_epoch,
                &next_record_version,
                &cutoff_hash.as_slice(),
                &revoked,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                UPDATE vault_shares
                SET active_epoch = $1, pending_epoch = NULL,
                    publication_fenced = FALSE, fence_snapshot_hash = NULL,
                    status = 'active', record_version = $2,
                    previous_record_hash = record_hash,
                    record_hash = $3, updated_at = now()
                WHERE id = $4
            ",
            &[
                &pending_epoch,
                &next_record_version,
                &cutoff_hash.as_slice(),
                &share_id,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "DELETE FROM vault_share_pending_revocations WHERE share_id = $1 AND pending_epoch = $2",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(ShareMutationResponse {
        share_id,
        active_epoch: pending_epoch,
        record_hash: encode_bytes(cutoff_hash),
        limitation: "Revocation prevents future access only; it cannot erase keys or plaintext already obtained by a recipient.",
    }))
}

pub async fn abort_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, i64)>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let (share_id, pending_epoch) = path.into_inner();
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let share = transaction
        .query_opt(
            "
                SELECT pending_epoch FROM vault_shares
                WHERE id = $1 AND owner_id = $2 AND status = 'rotating'
                FOR UPDATE
            ",
            &[&share_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(share) = share else {
        return Ok(HttpResponse::NoContent().finish());
    };
    if share.get::<_, Option<i64>>("pending_epoch") != Some(pending_epoch) {
        return Err(error::ErrorConflict("share rotation epoch changed"));
    }
    transaction
        .execute(
            "DELETE FROM vault_share_pending_revocations WHERE share_id = $1 AND pending_epoch = $2",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "DELETE FROM vault_share_epochs WHERE share_id = $1 AND epoch = $2 AND status = 'pending'",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .execute(
            "
                UPDATE vault_shares
                SET pending_epoch = NULL, publication_fenced = FALSE,
                    fence_snapshot_hash = NULL, status = 'active', updated_at = now()
                WHERE id = $1
            ",
            &[&share_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::NoContent().finish())
}

struct ActiveIdentity {
    key_version: i64,
    ed25519_public_key: Vec<u8>,
}

async fn active_identity(state: &AppState, user_id: &str) -> Result<ActiveIdentity> {
    let row = state
        .db
        .query_opt(
            "
                SELECT key_version, ed25519_public_key
                FROM vault_identity_keys
                WHERE user_id = $1 AND status = 'active'
                LIMIT 1
            ",
            &[&user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Err(error::ErrorPreconditionFailed(
            "an active vault identity is required",
        ));
    };
    Ok(ActiveIdentity {
        key_version: row.get("key_version"),
        ed25519_public_key: row.get("ed25519_public_key"),
    })
}

fn validate_owner_epoch_key(request: &OwnerEpochKeyRequest) -> Result<OwnerEpochKeyMaterial> {
    Ok(OwnerEpochKeyMaterial {
        wrapper_id: decode_fixed::<16>(&request.wrapper_id, "owner epoch wrapper id")?,
        ciphertext: decode_fixed::<48>(&request.ciphertext, "owner epoch ciphertext")?,
    })
}

async fn insert_owner_epoch_key(
    transaction: &tokio_postgres::Transaction<'_>,
    share_id: &str,
    epoch: i64,
    material: &OwnerEpochKeyMaterial,
) -> Result<()> {
    transaction
        .execute(
            "
                INSERT INTO vault_share_owner_keys (
                  share_id, epoch, wrapper_id, root_ciphertext
                ) VALUES ($1, $2, $3, $4)
            ",
            &[
                &share_id,
                &epoch,
                &material.wrapper_id.as_slice(),
                &material.ciphertext.as_slice(),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

fn decode_share_wrappers(
    encoded: &[String],
    share_id: &str,
    epoch: i64,
) -> Result<Vec<ShareWrapperMaterial>> {
    if encoded.is_empty() || encoded.len() > 8_192 || epoch <= 0 {
        return Err(error::ErrorBadRequest("share wrapper count is invalid"));
    }
    let mut ids = HashSet::new();
    encoded
        .iter()
        .map(|value| {
            let canonical = decode_limited(value, 65_536, "share wrapper")?;
            let record = decode_wrapper(&canonical).map_err(error::ErrorBadRequest)?;
            if !matches!(record.kind, 3 | 4)
                || record.share_id.as_deref() != Some(share_id)
                || i64::try_from(record.epoch.unwrap_or_default()).ok() != Some(epoch)
                || !ids.insert(record.wrapper_id)
            {
                return Err(error::ErrorBadRequest("share wrapper scope is invalid"));
            }
            let hash = sha256(&canonical);
            Ok(ShareWrapperMaterial {
                canonical,
                record,
                hash,
            })
        })
        .collect()
}

fn decode_share_envelopes(
    encoded: &[SignedEnvelopeRequest],
    sender_ed25519_public_key: &[u8],
) -> Result<Vec<ShareEnvelopeMaterial>> {
    if encoded.len() > 1_024 {
        return Err(error::ErrorBadRequest("share envelope count is invalid"));
    }
    let mut ids = HashSet::new();
    encoded
        .iter()
        .map(|value| {
            let canonical = decode_limited(&value.canonical_cbor, 131_072, "share envelope")?;
            let signature =
                decode_fixed::<64>(&value.signature, "share envelope signature")?.to_vec();
            let (record, hash) =
                verify_share_envelope(&canonical, &signature, sender_ed25519_public_key)
                    .map_err(error::ErrorBadRequest)?;
            if !ids.insert(record.envelope_id) {
                return Err(error::ErrorBadRequest("share envelope id is duplicated"));
            }
            Ok(ShareEnvelopeMaterial {
                canonical,
                signature,
                record,
                hash,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn validate_share_material(
    wrappers: &[ShareWrapperMaterial],
    envelopes: &[ShareEnvelopeMaterial],
    snapshot: &[SnapshotNode],
    share_id: &str,
    epoch: i64,
    sender_id: &str,
    sender_key_version: i64,
    recipient_id: &str,
    recipient_key_version: i64,
    root_node_id: &str,
    record_version: i64,
    previous_record_hash: Option<&[u8]>,
) -> Result<WrapperSetCommitment> {
    validate_wrapper_completeness(wrappers, snapshot)?;
    let commitment = share_wrapper_commitment(wrappers)?;
    if envelopes.len() != 1 {
        return Err(error::ErrorBadRequest(
            "each initial share requires exactly one recipient envelope",
        ));
    }
    validate_envelope(
        &envelopes[0],
        &commitment,
        share_id,
        epoch,
        sender_id,
        sender_key_version,
        recipient_id,
        recipient_key_version,
        root_node_id,
        record_version,
        previous_record_hash,
    )?;
    Ok(commitment)
}

#[allow(clippy::too_many_arguments)]
fn validate_rotation_material(
    wrappers: &[ShareWrapperMaterial],
    envelopes: &[ShareEnvelopeMaterial],
    snapshot: &[SnapshotNode],
    share_id: &str,
    epoch: i64,
    sender_id: &str,
    sender_key_version: i64,
    retained: &[(String, i64)],
    root_node_id: &str,
    record_version: i64,
    previous_record_hash: Option<&[u8]>,
) -> Result<WrapperSetCommitment> {
    validate_wrapper_completeness(wrappers, snapshot)?;
    let commitment = share_wrapper_commitment(wrappers)?;
    if envelopes.len() != retained.len() {
        return Err(error::ErrorBadRequest(
            "new epoch envelopes do not cover every retained recipient",
        ));
    }
    let expected = retained.iter().cloned().collect::<HashSet<_>>();
    let actual = envelopes
        .iter()
        .map(|envelope| {
            (
                envelope.record.recipient_id.clone(),
                envelope.record.recipient_key_version as i64,
            )
        })
        .collect::<HashSet<_>>();
    if expected != actual {
        return Err(error::ErrorBadRequest(
            "new epoch envelope recipients are incomplete",
        ));
    }
    for envelope in envelopes {
        validate_envelope(
            envelope,
            &commitment,
            share_id,
            epoch,
            sender_id,
            sender_key_version,
            &envelope.record.recipient_id,
            envelope.record.recipient_key_version as i64,
            root_node_id,
            record_version,
            previous_record_hash,
        )?;
    }
    Ok(commitment)
}

fn share_wrapper_commitment(wrappers: &[ShareWrapperMaterial]) -> Result<WrapperSetCommitment> {
    let hashes = wrappers
        .iter()
        .map(|wrapper| wrapper.hash)
        .collect::<Vec<_>>();
    wrapper_set_commitment(&hashes).map_err(error::ErrorBadRequest)
}

fn validate_wrapper_completeness(
    wrappers: &[ShareWrapperMaterial],
    snapshot: &[SnapshotNode],
) -> Result<()> {
    let mut expected = HashSet::new();
    for node in snapshot {
        expected.insert((node.node_id.clone(), 4_u64, None));
        if node.entry_type == "file" {
            expected.insert((node.node_id.clone(), 3_u64, node.generation_id.clone()));
        }
    }
    let actual = wrappers
        .iter()
        .map(|wrapper| {
            (
                wrapper.record.node_id.clone(),
                wrapper.record.kind,
                wrapper.record.generation_id.map(Vec::from),
            )
        })
        .collect::<HashSet<_>>();
    if expected != actual || actual.len() != wrappers.len() {
        return Err(error::ErrorBadRequest(
            "share wrappers do not cover the fenced subtree snapshot exactly",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_envelope(
    envelope: &ShareEnvelopeMaterial,
    commitment: &WrapperSetCommitment,
    share_id: &str,
    epoch: i64,
    sender_id: &str,
    sender_key_version: i64,
    recipient_id: &str,
    recipient_key_version: i64,
    root_node_id: &str,
    record_version: i64,
    previous_record_hash: Option<&[u8]>,
) -> Result<()> {
    let record = &envelope.record;
    if record.format_version != SHARE_ENVELOPE_VERSION
        || record.wrapper_set_root != Some(commitment.root)
        || i32::try_from(record.wrapper_count).ok() != Some(commitment.count)
        || !record.wrapper_hashes.is_empty()
        || record.share_id != share_id
        || i64::try_from(record.epoch).ok() != Some(epoch)
        || record.sender_id != sender_id
        || i64::try_from(record.sender_key_version).ok() != Some(sender_key_version)
        || record.recipient_id != recipient_id
        || i64::try_from(record.recipient_key_version).ok() != Some(recipient_key_version)
        || record.node_id != root_node_id
        || record.generation_scope.is_some()
        || i64::try_from(record.record_version).ok() != Some(record_version)
        || record
            .previous_record_hash
            .as_ref()
            .map(|value| value.as_slice())
            != previous_record_hash
    {
        return Err(error::ErrorBadRequest(
            "signed share envelope does not match the share epoch",
        ));
    }
    Ok(())
}

async fn subtree_snapshot(
    transaction: &tokio_postgres::Transaction<'_>,
    root_node_id: &str,
    owner_id: &str,
) -> Result<Vec<SnapshotNode>> {
    let rows = transaction
        .query(
            "
                WITH RECURSIVE subtree AS (
                  SELECT id, entry_type, current_generation_number, current_generation_id
                  FROM files
                  WHERE id = $1 AND owner_id = $2
                    AND state = 'active' AND e2ee_state = 'encrypted'
                  UNION ALL
                  SELECT child.id, child.entry_type, child.current_generation_number, child.current_generation_id
                  FROM files AS child
                  INNER JOIN subtree AS parent ON child.parent_id = parent.id
                  WHERE child.owner_id = $2
                    AND child.state = 'active' AND child.e2ee_state = 'encrypted'
                )
                SELECT subtree.id, subtree.entry_type,
                       subtree.current_generation_number, subtree.current_generation_id,
                       heads.record_version, heads.record_hash
                FROM subtree
                INNER JOIN vault_node_heads AS heads ON heads.node_id = subtree.id
                ORDER BY subtree.id
            ",
            &[&root_node_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if rows.is_empty() {
        return Err(error::ErrorConflict(
            "shared subtree is empty or incomplete",
        ));
    }
    Ok(rows
        .into_iter()
        .map(|row| SnapshotNode {
            node_id: row.get("id"),
            entry_type: row.get("entry_type"),
            generation_number: row.get("current_generation_number"),
            generation_id: row.get("current_generation_id"),
            record_version: row.get("record_version"),
            record_hash: row.get("record_hash"),
        })
        .collect())
}

fn snapshot_hash(snapshot: &[SnapshotNode]) -> [u8; 32] {
    let mut input = b"aeralyth/share-snapshot/v1".to_vec();
    for node in snapshot {
        append_length_prefixed(&mut input, node.node_id.as_bytes());
        append_length_prefixed(&mut input, node.entry_type.as_bytes());
        input.extend_from_slice(&node.generation_number.to_be_bytes());
        append_length_prefixed(
            &mut input,
            node.generation_id.as_deref().unwrap_or_default(),
        );
        input.extend_from_slice(&node.record_version.to_be_bytes());
        append_length_prefixed(&mut input, &node.record_hash);
    }
    sha256(&input)
}

fn share_record_hash(
    snapshot_hash: &[u8; 32],
    wrapper_commitment: &WrapperSetCommitment,
    envelopes: &[ShareEnvelopeMaterial],
    epoch: i64,
) -> [u8; 32] {
    let mut input = b"aeralyth/share-record/v1".to_vec();
    input.extend_from_slice(&epoch.to_be_bytes());
    input.extend_from_slice(snapshot_hash);
    // Commitment proofs are emitted in canonical wrapper-hash order. Reuse that order instead
    // of cloning and sorting the same set again for the share-record commitment.
    for proof in &wrapper_commitment.proofs {
        input.extend_from_slice(&proof.wrapper_hash);
    }
    let mut envelope_hashes = envelopes.iter().map(|value| value.hash).collect::<Vec<_>>();
    envelope_hashes.sort_unstable();
    for hash in envelope_hashes {
        input.extend_from_slice(&hash);
    }
    sha256(&input)
}

async fn committed_share_wrappers(
    transaction: &tokio_postgres::Transaction<'_>,
    decoded: &DecodedNodeRecord,
    node_id: &str,
    parent_id: Option<&str>,
    owner_id: &str,
    include_generation: bool,
) -> Result<Vec<ShareWrapperMaterial>> {
    let node_exists = transaction
        .query_opt("SELECT 1 FROM files WHERE id = $1", &[&node_id])
        .await
        .map_err(error::ErrorInternalServerError)?
        .is_some();
    let anchor = if node_exists {
        Some(node_id)
    } else {
        parent_id
    };
    let shares = if let Some(anchor) = anchor {
        transaction
            .query(
                "
                    WITH RECURSIVE ancestors AS (
                      SELECT id, parent_id FROM files
                      WHERE id = $1 AND owner_id = $2
                      UNION ALL
                      SELECT parent.id, parent.parent_id
                      FROM files AS parent
                      INNER JOIN ancestors AS child ON child.parent_id = parent.id
                      WHERE parent.owner_id = $2
                    )
                    SELECT shares.id, shares.active_epoch
                    FROM vault_shares AS shares
                    INNER JOIN ancestors ON ancestors.id = shares.root_node_id
                    WHERE shares.owner_id = $2 AND shares.status = 'active'
                      AND shares.publication_fenced = FALSE
                    ORDER BY shares.id
                    FOR SHARE OF shares
                ",
                &[&anchor, &owner_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
    } else {
        Vec::new()
    };
    let mut expected = HashSet::new();
    for share in shares {
        let share_id: String = share.get("id");
        let epoch: i64 = share.get("active_epoch");
        expected.insert((share_id.clone(), epoch, 4_u64, None));
        if include_generation {
            expected.insert((
                share_id,
                epoch,
                3_u64,
                Some(decoded.verified.bootstrap.generation_id.to_vec()),
            ));
        }
    }

    let mut material = Vec::new();
    let mut actual = HashSet::new();
    for canonical in &decoded.wrappers {
        let record = decode_wrapper(canonical).map_err(error::ErrorBadRequest)?;
        if !matches!(record.kind, 3 | 4) {
            continue;
        }
        if record.node_id != node_id
            || record.record_version != decoded.verified.bootstrap.record_version
        {
            return Err(error::ErrorBadRequest(
                "committed share wrapper targets another node record",
            ));
        }
        let share_id = record.share_id.clone().unwrap_or_default();
        let epoch = i64::try_from(record.epoch.unwrap_or_default())
            .map_err(|_| error::ErrorBadRequest("share epoch is invalid"))?;
        let generation_id = record.generation_id.map(Vec::from);
        if !actual.insert((share_id, epoch, record.kind, generation_id)) {
            return Err(error::ErrorBadRequest("share wrapper is duplicated"));
        }
        material.push(ShareWrapperMaterial {
            hash: sha256(canonical),
            canonical: canonical.clone(),
            record,
        });
    }
    if actual != expected {
        return Err(error::ErrorConflict(
            "active shares changed; regenerate the node record with current share-epoch wrappers",
        ));
    }
    Ok(material)
}

async fn publication_share_wrappers(
    transaction: &tokio_postgres::Transaction<'_>,
    decoded: &DecodedNodeRecord,
    node_id: &str,
    parent_id: Option<&str>,
    owner_id: &str,
    include_generation: bool,
) -> Result<(Vec<ShareWrapperMaterial>, bool)> {
    let has_inline_share_wrappers =
        decoded
            .wrappers
            .iter()
            .try_fold(false, |found, canonical| -> Result<bool> {
                let wrapper = decode_wrapper(canonical).map_err(error::ErrorBadRequest)?;
                Ok(found || matches!(wrapper.kind, 3 | 4))
            })?;
    if has_inline_share_wrappers {
        return Ok((
            committed_share_wrappers(
                transaction,
                decoded,
                node_id,
                parent_id,
                owner_id,
                include_generation,
            )
            .await?,
            false,
        ));
    }

    let node_exists = transaction
        .query_opt("SELECT 1 FROM files WHERE id = $1", &[&node_id])
        .await
        .map_err(error::ErrorInternalServerError)?
        .is_some();
    let anchor = if node_exists {
        Some(node_id)
    } else {
        parent_id
    };
    let Some(anchor) = anchor else {
        return Ok((Vec::new(), false));
    };
    let row = transaction
        .query_one(
            "
                SELECT EXISTS (
                  WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id FROM files
                    WHERE id = $1 AND owner_id = $2
                    UNION ALL
                    SELECT parent.id, parent.parent_id
                    FROM files AS parent
                    INNER JOIN ancestors AS child ON child.parent_id = parent.id
                    WHERE parent.owner_id = $2
                  )
                  SELECT 1
                  FROM vault_shares AS shares
                  INNER JOIN ancestors ON ancestors.id = shares.root_node_id
                  WHERE shares.owner_id = $2 AND shares.status = 'active'
                    AND shares.publication_fenced = FALSE
                  LIMIT 1
                ) AS required
            ",
            &[&anchor, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok((Vec::new(), row.get("required")))
}

async fn update_share_sync_job(
    transaction: &tokio_postgres::Transaction<'_>,
    node_id: &str,
    owner_id: &str,
    record_version: i64,
    required: bool,
) -> Result<()> {
    if required {
        transaction
            .execute(
                "
                    INSERT INTO vault_share_sync_jobs (
                      node_id, owner_id, record_version
                    ) VALUES ($1, $2, $3)
                    ON CONFLICT (node_id) DO UPDATE SET
                      owner_id = EXCLUDED.owner_id,
                      record_version = EXCLUDED.record_version,
                      attempts = 0,
                      last_error = NULL,
                      updated_at = now()
                ",
                &[&node_id, &owner_id, &record_version],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    } else {
        transaction
            .execute(
                "DELETE FROM vault_share_sync_jobs WHERE node_id = $1 AND owner_id = $2",
                &[&node_id, &owner_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    Ok(())
}

async fn insert_share_wrappers(
    transaction: &tokio_postgres::Transaction<'_>,
    wrappers: &[ShareWrapperMaterial],
    commitment: Option<(&WrapperSetCommitment, &'static str)>,
) -> Result<()> {
    if wrappers.is_empty() {
        return Ok(());
    }

    let proofs = commitment.map(|(value, _)| {
        value
            .proofs
            .iter()
            .map(|proof| (proof.wrapper_hash, (proof.leaf_index, proof.proof.clone())))
            .collect::<HashMap<_, _>>()
    });
    let commitment_source = commitment.map(|(_, source)| source).unwrap_or("bootstrap");

    let mut wrapper_ids = Vec::with_capacity(wrappers.len());
    let mut share_ids = Vec::with_capacity(wrappers.len());
    let mut epochs = Vec::with_capacity(wrappers.len());
    let mut node_ids = Vec::with_capacity(wrappers.len());
    let mut generation_ids = Vec::with_capacity(wrappers.len());
    let mut wrapper_kinds = Vec::with_capacity(wrappers.len());
    let mut record_versions = Vec::with_capacity(wrappers.len());
    let mut canonical_records = Vec::with_capacity(wrappers.len());
    let mut wrapper_hashes = Vec::with_capacity(wrappers.len());
    let mut leaf_indices = Vec::with_capacity(wrappers.len());
    let mut merkle_proofs = Vec::with_capacity(wrappers.len());

    for wrapper in wrappers {
        let epoch = i64::try_from(wrapper.record.epoch.unwrap_or_default())
            .map_err(|_| error::ErrorBadRequest("share epoch is invalid"))?;
        let (leaf_index, merkle_proof) = if let Some(proofs) = proofs.as_ref() {
            let Some((leaf_index, proof)) = proofs.get(&wrapper.hash) else {
                return Err(error::ErrorInternalServerError(
                    "share wrapper proof is missing",
                ));
            };
            (Some(*leaf_index), Some(proof.clone()))
        } else {
            (None, None)
        };

        wrapper_ids.push(wrapper.record.wrapper_id.to_vec());
        share_ids.push(wrapper.record.share_id.clone().unwrap_or_default());
        epochs.push(epoch);
        node_ids.push(wrapper.record.node_id.clone());
        generation_ids.push(wrapper.record.generation_id.map(|value| value.to_vec()));
        wrapper_kinds.push(if wrapper.record.kind == 3 {
            "generation_dek".to_owned()
        } else {
            "metadata".to_owned()
        });
        record_versions.push(wrapper.record.record_version as i64);
        canonical_records.push(wrapper.canonical.clone());
        wrapper_hashes.push(wrapper.hash.to_vec());
        leaf_indices.push(leaf_index);
        merkle_proofs.push(merkle_proof);
    }

    transaction
        .execute(
            "
            INSERT INTO vault_share_wrappers (
              wrapper_id, share_id, epoch, node_id, generation_id,
              wrapper_kind, record_version, canonical_cbor, wrapper_hash,
              merkle_leaf_index, merkle_proof, commitment_source
            )
            SELECT batch.wrapper_id, batch.share_id, batch.epoch,
                   batch.node_id, batch.generation_id, batch.wrapper_kind,
                   batch.record_version, batch.canonical_cbor,
                   batch.wrapper_hash, batch.merkle_leaf_index,
                   batch.merkle_proof, $12
            FROM unnest(
              $1::bytea[], $2::text[], $3::bigint[], $4::text[],
              $5::bytea[], $6::text[], $7::bigint[], $8::bytea[],
              $9::bytea[], $10::integer[], $11::bytea[]
            ) AS batch(
              wrapper_id, share_id, epoch, node_id, generation_id,
              wrapper_kind, record_version, canonical_cbor, wrapper_hash,
              merkle_leaf_index, merkle_proof
            )
            ",
            &[
                &wrapper_ids,
                &share_ids,
                &epochs,
                &node_ids,
                &generation_ids,
                &wrapper_kinds,
                &record_versions,
                &canonical_records,
                &wrapper_hashes,
                &leaf_indices,
                &merkle_proofs,
                &commitment_source,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

async fn insert_share_envelopes(
    transaction: &tokio_postgres::Transaction<'_>,
    envelopes: &[ShareEnvelopeMaterial],
) -> Result<()> {
    if envelopes.is_empty() {
        return Ok(());
    }

    let mut envelope_ids = Vec::with_capacity(envelopes.len());
    let mut share_ids = Vec::with_capacity(envelopes.len());
    let mut epochs = Vec::with_capacity(envelopes.len());
    let mut sender_ids = Vec::with_capacity(envelopes.len());
    let mut sender_key_versions = Vec::with_capacity(envelopes.len());
    let mut recipient_ids = Vec::with_capacity(envelopes.len());
    let mut recipient_key_versions = Vec::with_capacity(envelopes.len());
    let mut node_ids = Vec::with_capacity(envelopes.len());
    let mut generation_scopes = Vec::with_capacity(envelopes.len());
    let mut record_versions = Vec::with_capacity(envelopes.len());
    let mut previous_record_hashes = Vec::with_capacity(envelopes.len());
    let mut encapsulated_keys = Vec::with_capacity(envelopes.len());
    let mut ciphertexts = Vec::with_capacity(envelopes.len());
    let mut canonical_records = Vec::with_capacity(envelopes.len());
    let mut signatures = Vec::with_capacity(envelopes.len());
    let mut envelope_hashes = Vec::with_capacity(envelopes.len());

    for envelope in envelopes {
        let record = &envelope.record;
        envelope_ids.push(record.envelope_id.to_vec());
        share_ids.push(record.share_id.clone());
        epochs.push(record.epoch as i64);
        sender_ids.push(record.sender_id.clone());
        sender_key_versions.push(record.sender_key_version as i64);
        recipient_ids.push(record.recipient_id.clone());
        recipient_key_versions.push(record.recipient_key_version as i64);
        node_ids.push(record.node_id.clone());
        generation_scopes.push(record.generation_scope.map(|value| value as i64));
        record_versions.push(record.record_version as i64);
        previous_record_hashes.push(record.previous_record_hash.map(|value| value.to_vec()));
        encapsulated_keys.push(record.encapsulated_key.to_vec());
        ciphertexts.push(record.ciphertext.clone());
        canonical_records.push(envelope.canonical.clone());
        signatures.push(envelope.signature.clone());
        envelope_hashes.push(envelope.hash.to_vec());
    }

    transaction
        .execute(
            "
            INSERT INTO vault_share_envelopes (
              envelope_id, share_id, epoch, sender_id,
              sender_key_version, recipient_id, recipient_key_version,
              node_id, permissions, generation_scope, record_version,
              previous_record_hash, encapsulated_key, ciphertext,
              canonical_cbor, signature, envelope_hash
            )
            SELECT batch.envelope_id, batch.share_id, batch.epoch,
                   batch.sender_id, batch.sender_key_version,
                   batch.recipient_id, batch.recipient_key_version,
                   batch.node_id, 'read', batch.generation_scope,
                   batch.record_version, batch.previous_record_hash,
                   batch.encapsulated_key, batch.ciphertext,
                   batch.canonical_cbor, batch.signature, batch.envelope_hash
            FROM unnest(
              $1::bytea[], $2::text[], $3::bigint[], $4::text[],
              $5::bigint[], $6::text[], $7::bigint[], $8::text[],
              $9::bigint[], $10::bigint[], $11::bytea[], $12::bytea[],
              $13::bytea[], $14::bytea[], $15::bytea[], $16::bytea[]
            ) AS batch(
              envelope_id, share_id, epoch, sender_id,
              sender_key_version, recipient_id, recipient_key_version,
              node_id, generation_scope, record_version,
              previous_record_hash, encapsulated_key, ciphertext,
              canonical_cbor, signature, envelope_hash
            )
            ",
            &[
                &envelope_ids,
                &share_ids,
                &epochs,
                &sender_ids,
                &sender_key_versions,
                &recipient_ids,
                &recipient_key_versions,
                &node_ids,
                &generation_scopes,
                &record_versions,
                &previous_record_hashes,
                &encapsulated_keys,
                &ciphertexts,
                &canonical_records,
                &signatures,
                &envelope_hashes,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

fn snapshot_response(node: SnapshotNode) -> EpochNodeSnapshot {
    EpochNodeSnapshot {
        node_id: node.node_id,
        entry_type: node.entry_type,
        generation_number: node.generation_number,
        generation_id: node.generation_id.map(encode_bytes),
        record_version: node.record_version,
        record_hash: encode_bytes(node.record_hash),
    }
}

fn append_length_prefixed(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value);
}

async fn finalize_ciphertext_object(
    state: &AppState,
    user: &SessionPrincipal,
    upload: &VaultUpload,
    parts: &[UploadedPart],
) -> Result<Option<ObjectMetadata>> {
    if upload.mode == "none" {
        return Ok(None);
    }
    let object_key = upload
        .object_key
        .as_deref()
        .ok_or_else(|| error::ErrorInternalServerError("object key is missing"))?;
    if upload.status == "pending" {
        let claimed = state
            .db
            .execute(
                "UPDATE vault_uploads SET status = 'completing', expires_at = now() + interval '10 minutes' WHERE id = $1 AND owner_id = $2 AND status = 'pending'",
                &[&upload.id, &user.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        if claimed != 1 {
            return Err(error::ErrorConflict("upload state changed; retry"));
        }
    }
    state.db.release_request_connection().await;
    if upload.mode == "multipart" {
        let multipart_id = upload
            .multipart_upload_id
            .as_deref()
            .ok_or_else(|| error::ErrorInternalServerError("multipart upload id is missing"))?;
        if let Err(complete_error) = state
            .storage
            .complete_multipart(object_key, multipart_id, parts)
            .await
        {
            match state.storage.object_metadata(object_key).await {
                Ok(metadata) => return verify_object_metadata(upload, metadata).map(Some),
                Err(metadata_error) if metadata_error.is_not_found() => {
                    state
                        .db
                        .execute(
                            "UPDATE vault_uploads SET status = 'pending', expires_at = now() + interval '24 hours' WHERE id = $1 AND owner_id = $2 AND status = 'completing'",
                            &[&upload.id, &user.id],
                        )
                        .await
                        .map_err(error::ErrorInternalServerError)?;
                    return Err(error::ErrorBadGateway(complete_error));
                }
                Err(metadata_error) => {
                    log::warn!(
                        "encrypted upload {} completion is uncertain: {}; metadata: {}",
                        upload.id,
                        complete_error,
                        metadata_error
                    );
                    return Err(error::ErrorServiceUnavailable(
                        "upload completion is being reconciled; retry shortly",
                    ));
                }
            }
        }
    }
    let metadata = state
        .storage
        .object_metadata(object_key)
        .await
        .map_err(error::ErrorBadGateway)?;
    verify_object_metadata(upload, metadata).map(Some)
}

fn verify_object_metadata(
    upload: &VaultUpload,
    metadata: ObjectMetadata,
) -> Result<ObjectMetadata> {
    if u64::try_from(upload.ciphertext_length).ok() != Some(metadata.size_bytes) {
        return Err(error::ErrorBadRequest(
            "ciphertext object length does not match the signed generation",
        ));
    }
    if upload.mode == "single"
        && upload.checksum_sha256.as_deref() != metadata.checksum_sha256.as_deref()
    {
        return Err(error::ErrorBadRequest(
            "ciphertext object checksum verification failed",
        ));
    }
    Ok(metadata)
}

async fn publish_record_transaction(
    state: &AppState,
    user: &SessionPrincipal,
    upload: &VaultUpload,
    decoded: &DecodedNodeRecord,
    metadata: Option<&ObjectMetadata>,
) -> Result<PublishResponse> {
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let existing = transaction
        .query_opt(
            "
                SELECT owner_id, parent_id, entry_type, e2ee_state,
                       current_generation_number, current_generation_id,
                       storage_name
                FROM files WHERE id = $1 FOR UPDATE
            ",
            &[&upload.node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let mut is_migration = false;
    if let Some(existing) = existing.as_ref() {
        if existing.get::<_, String>("owner_id") != user.id
            || existing.get::<_, String>("entry_type") != upload.entry_type
            || existing.get::<_, Option<String>>("parent_id") != upload.parent_id
        {
            return Err(error::ErrorConflict("node identity changed"));
        }
        match existing.get::<_, String>("e2ee_state").as_str() {
            "encrypted" => {}
            "staged" => {
                let migration = transaction
                    .query_opt(
                        "
                            SELECT state FROM vault_migrations
                            WHERE node_id = $1 AND owner_id = $2
                            FOR UPDATE
                        ",
                        &[&upload.node_id, &user.id],
                    )
                    .await
                    .map_err(error::ErrorInternalServerError)?;
                if migration
                    .as_ref()
                    .map(|row| row.get::<_, String>("state"))
                    .as_deref()
                    != Some("encrypting")
                    || upload.generation_number != 1
                    || decoded.verified.bootstrap.record_version != 1
                {
                    return Err(error::ErrorConflict("legacy migration state changed"));
                }
                is_migration = true;
            }
            _ => return Err(error::ErrorConflict("node identity changed")),
        }
    } else if upload.generation_number != 1 || decoded.verified.bootstrap.record_version != 1 {
        return Err(error::ErrorConflict(
            "a new node must start at generation and record version one",
        ));
    }

    let head = transaction
        .query_opt(
            "SELECT record_version, record_hash FROM vault_node_heads WHERE node_id = $1 FOR UPDATE",
            &[&upload.node_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    match head {
        Some(head) => validate_head_cas(
            head.get("record_version"),
            head.get::<_, Vec<u8>>("record_hash").as_slice(),
            &decoded.verified.bootstrap,
        )?,
        None if decoded.verified.bootstrap.record_version == 1
            && decoded.verified.bootstrap.previous_record_hash.is_none() => {}
        None => {
            return Err(error::ErrorConflict(
                "node head changed; regenerate the record",
            ));
        }
    }
    if let Some(existing) = existing.as_ref()
        && !is_migration
    {
        let current_generation: Option<i64> = existing.get("current_generation_number");
        if current_generation.map(|value| value + 1) != Some(upload.generation_number) {
            return Err(error::ErrorConflict(
                "node generation changed; regenerate the upload",
            ));
        }
    }
    reject_fenced_share_write(
        &transaction,
        &upload.node_id,
        upload.parent_id.as_deref(),
        &user.id,
    )
    .await?;
    validate_owner_wrappers(decoded, upload.parent_id.as_deref())?;
    let (committed_share_wrappers, share_sync_required) = publication_share_wrappers(
        &transaction,
        decoded,
        &upload.node_id,
        upload.parent_id.as_deref(),
        &user.id,
        upload.entry_type == "file",
    )
    .await?;

    let storage_name = upload
        .object_key
        .clone()
        .unwrap_or_else(|| format!("vault-folder/{}", upload.node_id));
    let size_bytes = upload.ciphertext_length;
    let object_checksum = metadata.and_then(|value| value.checksum_sha256.clone());
    let object_etag = metadata.and_then(|value| value.etag.clone());
    if existing.is_none() {
        transaction
            .execute(
                "
                    INSERT INTO files (
                      id, owner_id, original_name, storage_name, mime_type,
                      size_bytes, entry_type, parent_id, checksum_sha256,
                      object_etag, e2ee_state, current_generation_number,
                      current_generation_id
                    )
                    VALUES ($1, $2, $3, $4, 'application/octet-stream', $5, $6, $7, $8, $9, 'encrypted', $10, $11)
                ",
                &[
                    &upload.node_id,
                    &user.id,
                    &format!("encrypted-{}", upload.node_id.chars().rev().take(8).collect::<String>()),
                    &storage_name,
                    &size_bytes,
                    &upload.entry_type,
                    &upload.parent_id,
                    &object_checksum,
                    &object_etag,
                    &upload.generation_number,
                    &upload.generation_id,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    } else if let Some(existing) = existing.as_ref() {
        let old_storage_name: String = existing.get("storage_name");
        transaction
            .execute(
                "
                    UPDATE files
                    SET original_name = $1,
                        storage_name = $2, mime_type = 'application/octet-stream',
                        size_bytes = $3, checksum_sha256 = $4, object_etag = $5,
                        e2ee_state = 'encrypted', current_generation_number = $6,
                        current_generation_id = $7, updated_at = now()
                    WHERE id = $8 AND owner_id = $9
                ",
                &[
                    &format!(
                        "encrypted-{}",
                        upload.node_id.chars().rev().take(8).collect::<String>()
                    ),
                    &storage_name,
                    &size_bytes,
                    &object_checksum,
                    &object_etag,
                    &upload.generation_number,
                    &upload.generation_id,
                    &upload.node_id,
                    &user.id,
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        if upload.entry_type == "file" && old_storage_name != storage_name {
            transaction
                .execute(
                    "UPDATE vault_object_generations SET status = 'retired', retired_at = now() WHERE node_id = $1 AND status = 'published'",
                    &[&upload.node_id],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
            transaction
                .execute(
                    "INSERT INTO storage_deletion_jobs (object_key) VALUES ($1) ON CONFLICT (object_key) DO NOTHING",
                    &[&old_storage_name],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
        }
        if is_migration {
            let migration_state = if upload.entry_type == "file" {
                "cleanup_queued"
            } else {
                "complete"
            };
            transaction
                .execute(
                    "
                        UPDATE vault_migrations
                        SET staged_object_key = $1, state = $2,
                            last_error = NULL, updated_at = now()
                        WHERE node_id = $3 AND owner_id = $4
                    ",
                    &[
                        &upload.object_key,
                        &migration_state,
                        &upload.node_id,
                        &user.id,
                    ],
                )
                .await
                .map_err(error::ErrorInternalServerError)?;
        }
    }

    insert_node_record(&transaction, &user.id, decoded).await?;
    update_share_sync_job(
        &transaction,
        &upload.node_id,
        &user.id,
        i64::try_from(decoded.verified.bootstrap.record_version)
            .map_err(|_| error::ErrorBadRequest("record version is invalid"))?,
        share_sync_required,
    )
    .await?;
    replace_owner_wrappers(&transaction, &user.id, decoded).await?;
    insert_share_wrappers(&transaction, &committed_share_wrappers, None).await?;
    update_node_head(&transaction, &user.id, decoded).await?;
    if upload.entry_type == "file" {
        transaction
            .execute(
                "
                    INSERT INTO vault_object_generations (
                      node_id, owner_id, generation_number, generation_id,
                      object_key, ciphertext_length, chunk_count,
                      ciphertext_merkle_root, status
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
                ",
                &[
                    &upload.node_id,
                    &user.id,
                    &upload.generation_number,
                    &upload.generation_id,
                    &storage_name,
                    &upload.ciphertext_length,
                    &upload.chunk_count,
                    &decoded.verified.bootstrap.ciphertext_merkle_root.as_slice(),
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    transaction
        .execute(
            "UPDATE vault_uploads SET status = 'published', published_at = now() WHERE id = $1 AND owner_id = $2 AND status IN ('pending', 'completing')",
            &[&upload.id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(PublishResponse {
        node_id: upload.node_id.clone(),
        generation_number: upload.generation_number,
        generation_id: encode_bytes(&upload.generation_id),
        record_version: decoded.verified.bootstrap.record_version as i64,
        record_hash: encode_bytes(decoded.verified.record_hash),
        share_sync_required,
    })
}

async fn decode_and_verify_node_record(
    state: &AppState,
    user: &SessionPrincipal,
    body: &PublishUploadRequest,
) -> Result<DecodedNodeRecord> {
    let bootstrap_cbor = decode_limited(&body.bootstrap_cbor, 65_536, "bootstrap record")?;
    let signature = decode_fixed::<64>(&body.bootstrap_signature, "bootstrap signature")?.to_vec();
    let encrypted_manifest = decode_limited(
        &body.encrypted_manifest,
        MAX_MANIFEST_CIPHERTEXT,
        "encrypted manifest",
    )?;
    if body.wrappers.is_empty() || body.wrappers.len() > 4_096 {
        return Err(error::ErrorBadRequest("wrapper count is invalid"));
    }
    let wrappers = body
        .wrappers
        .iter()
        .map(|wrapper| decode_limited(wrapper, 65_536, "key wrapper"))
        .collect::<Result<Vec<_>>>()?;
    let bootstrap = decode_bootstrap(&bootstrap_cbor).map_err(error::ErrorBadRequest)?;
    let signer_key_version = i64::try_from(bootstrap.signer_key_version)
        .map_err(|_| error::ErrorBadRequest("signer key version is invalid"))?;
    let identity = state
        .db
        .query_opt(
            "
                SELECT ed25519_public_key
                FROM vault_identity_keys
                WHERE user_id = $1 AND key_version = $2 AND status = 'active'
                LIMIT 1
            ",
            &[&user.id, &signer_key_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(identity) = identity else {
        return Err(error::ErrorForbidden("signing identity is not active"));
    };
    let public_key: Vec<u8> = identity.get("ed25519_public_key");
    state.db.release_request_connection().await;
    let verified = verify_node_record(
        &bootstrap_cbor,
        &signature,
        &encrypted_manifest,
        &wrappers,
        &public_key,
    )
    .map_err(error::ErrorBadRequest)?;

    Ok(DecodedNodeRecord {
        bootstrap_cbor,
        signature,
        encrypted_manifest,
        wrappers,
        verified,
    })
}

fn validate_record_for_upload(decoded: &DecodedNodeRecord, upload: &VaultUpload) -> Result<()> {
    let bootstrap = &decoded.verified.bootstrap;
    if bootstrap.node_id != upload.node_id
        || i64::try_from(bootstrap.generation_number).ok() != Some(upload.generation_number)
        || bootstrap.generation_id.as_slice() != upload.generation_id
        || i64::try_from(bootstrap.ciphertext_length).ok() != Some(upload.ciphertext_length)
    {
        return Err(error::ErrorBadRequest(
            "signed bootstrap does not match the staged upload",
        ));
    }
    if upload.entry_type == "folder" {
        if bootstrap.ciphertext_merkle_root != sha256(&[]) {
            return Err(error::ErrorBadRequest(
                "folder bootstrap has an invalid empty ciphertext commitment",
            ));
        }
    } else if upload.chunk_count <= 0 {
        return Err(error::ErrorBadRequest("file chunk count is invalid"));
    }

    Ok(())
}

fn validate_owner_wrappers(decoded: &DecodedNodeRecord, parent_id: Option<&str>) -> Result<()> {
    let owner_wrappers = decoded
        .wrappers
        .iter()
        .map(|canonical| decode_wrapper(canonical).map_err(error::ErrorBadRequest))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|wrapper| matches!(wrapper.kind, 1 | 2))
        .collect::<Vec<_>>();
    if owner_wrappers.len() != 1 {
        return Err(error::ErrorBadRequest(
            "an owner record must contain exactly one node-key wrapper",
        ));
    }
    let wrapper = &owner_wrappers[0];
    match parent_id {
        Some(parent_id)
            if wrapper.kind == 2 && wrapper.parent_node_id.as_deref() == Some(parent_id) => {}
        None if wrapper.kind == 1 && wrapper.parent_node_id.is_none() => {}
        _ => {
            return Err(error::ErrorBadRequest(
                "node-key wrapper does not match the node parent",
            ));
        }
    }
    Ok(())
}

fn validate_completed_parts(
    upload: &VaultUpload,
    requested: &[CompletedUploadPartRequest],
) -> Result<Vec<UploadedPart>> {
    if upload.mode != "multipart" {
        if requested.is_empty() {
            return Ok(Vec::new());
        }
        return Err(error::ErrorBadRequest("multipart parts are not expected"));
    }
    let ciphertext_length = u64::try_from(upload.ciphertext_length)
        .map_err(|_| error::ErrorInternalServerError("ciphertext length is invalid"))?;
    let expected_count = ciphertext_length.div_ceil(UPLOAD_PART_BYTES);
    if requested.is_empty()
        || requested.len() > 10_000
        || u64::try_from(requested.len()).ok() != Some(expected_count)
    {
        return Err(error::ErrorBadRequest("multipart parts are invalid"));
    }
    let mut parts = requested
        .iter()
        .map(|part| {
            Ok(UploadedPart {
                part_number: part.part_number,
                etag: part.etag.trim().to_owned(),
                checksum_sha256: validate_sha256_checksum(&part.checksum_sha256)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    parts.sort_by_key(|part| part.part_number);
    if parts.iter().enumerate().any(|(index, part)| {
        part.part_number != i32::try_from(index + 1).unwrap_or(-1) || part.etag.is_empty()
    }) {
        return Err(error::ErrorBadRequest("multipart parts are invalid"));
    }
    Ok(parts)
}

async fn insert_node_record(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_id: &str,
    decoded: &DecodedNodeRecord,
) -> Result<()> {
    let bootstrap = &decoded.verified.bootstrap;
    let record_version = i64::try_from(bootstrap.record_version)
        .map_err(|_| error::ErrorBadRequest("record version is invalid"))?;
    let signer_key_version = i64::try_from(bootstrap.signer_key_version)
        .map_err(|_| error::ErrorBadRequest("signer key version is invalid"))?;
    transaction
        .execute(
            "
                INSERT INTO vault_node_records (
                  node_id, owner_id, record_version, record_hash,
                  previous_record_hash, bootstrap_cbor, bootstrap_signature,
                  encrypted_manifest, manifest_hash, signer_key_version
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ",
            &[
                &bootstrap.node_id,
                &owner_id,
                &record_version,
                &decoded.verified.record_hash.as_slice(),
                &bootstrap.previous_record_hash.map(|value| value.to_vec()),
                &decoded.bootstrap_cbor,
                &decoded.signature,
                &decoded.encrypted_manifest,
                &bootstrap.manifest_hash.as_slice(),
                &signer_key_version,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

async fn replace_owner_wrappers(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_id: &str,
    decoded: &DecodedNodeRecord,
) -> Result<()> {
    for canonical in &decoded.wrappers {
        let wrapper = decode_wrapper(canonical).map_err(error::ErrorBadRequest)?;
        if !matches!(wrapper.kind, 1 | 2) {
            continue;
        }
        let kind = if wrapper.kind == 1 {
            "account_root"
        } else {
            "parent_node"
        };
        let record_version = i64::try_from(wrapper.record_version)
            .map_err(|_| error::ErrorBadRequest("wrapper version is invalid"))?;
        let wrapper_hash = sha256(canonical);
        transaction
            .execute(
                "
                    INSERT INTO vault_wrappers (
                      wrapper_id, owner_id, node_id, parent_node_id,
                      wrapper_kind, record_version, canonical_cbor, wrapper_hash
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ",
                &[
                    &wrapper.wrapper_id.as_slice(),
                    &owner_id,
                    &wrapper.node_id,
                    &wrapper.parent_node_id,
                    &kind,
                    &record_version,
                    &canonical,
                    &wrapper_hash.as_slice(),
                ],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
    }
    Ok(())
}

async fn update_node_head(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_id: &str,
    decoded: &DecodedNodeRecord,
) -> Result<()> {
    let bootstrap = &decoded.verified.bootstrap;
    let record_version = i64::try_from(bootstrap.record_version)
        .map_err(|_| error::ErrorBadRequest("record version is invalid"))?;
    transaction
        .execute(
            "
                INSERT INTO vault_node_heads (
                  node_id, owner_id, record_version, record_hash
                )
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (node_id) DO UPDATE SET
                  record_version = EXCLUDED.record_version,
                  record_hash = EXCLUDED.record_hash,
                  updated_at = now()
            ",
            &[
                &bootstrap.node_id,
                &owner_id,
                &record_version,
                &decoded.verified.record_hash.as_slice(),
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

fn validate_head_cas(
    current_version: i64,
    current_hash: &[u8],
    bootstrap: &crate::e2ee::BootstrapRecord,
) -> Result<()> {
    let expected_version = u64::try_from(current_version)
        .ok()
        .and_then(|version| version.checked_add(1));
    if expected_version != Some(bootstrap.record_version)
        || bootstrap
            .previous_record_hash
            .as_ref()
            .map(|value| value.as_slice())
            != Some(current_hash)
    {
        return Err(error::ErrorConflict(
            "node head changed; fetch the current head and regenerate with fresh encryption ids",
        ));
    }
    Ok(())
}

async fn reject_fenced_share_write(
    transaction: &tokio_postgres::Transaction<'_>,
    node_id: &str,
    parent_id: Option<&str>,
    owner_id: &str,
) -> Result<()> {
    let anchor = if transaction
        .query_opt("SELECT 1 FROM files WHERE id = $1", &[&node_id])
        .await
        .map_err(error::ErrorInternalServerError)?
        .is_some()
    {
        Some(node_id)
    } else {
        parent_id
    };
    let Some(anchor) = anchor else {
        return Ok(());
    };
    let row = transaction
        .query_one(
            "
                SELECT EXISTS (
                  WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id FROM files
                    WHERE id = $1 AND owner_id = $2
                    UNION ALL
                    SELECT parent.id, parent.parent_id
                    FROM files AS parent
                    INNER JOIN ancestors AS child ON child.parent_id = parent.id
                    WHERE parent.owner_id = $2
                  )
                  SELECT 1
                  FROM vault_shares AS shares
                  INNER JOIN ancestors ON ancestors.id = shares.root_node_id
                  WHERE shares.owner_id = $2
                    AND (shares.status = 'rotating' OR shares.publication_fenced)
                  LIMIT 1
                ) AS blocked
            ",
            &[&anchor, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if row.get::<_, bool>("blocked") {
        return Err(error::ErrorConflict(
            "a share epoch rotation is publishing; regenerate after it completes",
        ));
    }
    Ok(())
}

async fn lock_share_topology(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_id: &str,
) -> Result<()> {
    transaction
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 11881376))",
            &[&owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(())
}

async fn current_publish_response(
    state: &AppState,
    user: &SessionPrincipal,
    node_id: &str,
) -> Result<HttpResponse> {
    let row = state
        .db
        .query_opt(
            "
                SELECT files.current_generation_number, files.current_generation_id,
                       heads.record_version, heads.record_hash,
                       EXISTS (
                         SELECT 1 FROM vault_share_sync_jobs AS jobs
                         WHERE jobs.node_id = files.id
                           AND jobs.record_version = heads.record_version
                       ) AS share_sync_required
                FROM files
                INNER JOIN vault_node_heads AS heads ON heads.node_id = files.id
                WHERE files.id = $1 AND files.owner_id = $2
            ",
            &[&node_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Ok(HttpResponse::Conflict().body("published node is unavailable"));
    };
    Ok(HttpResponse::Ok().json(PublishResponse {
        node_id: node_id.to_owned(),
        generation_number: row.get("current_generation_number"),
        generation_id: encode_bytes(row.get::<_, Vec<u8>>("current_generation_id")),
        record_version: row.get("record_version"),
        record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
        share_sync_required: row.get("share_sync_required"),
    }))
}

async fn shared_download_plan(
    state: &AppState,
    user: &SessionPrincipal,
    node_id: &str,
) -> Result<HttpResponse> {
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let share = transaction
        .query_opt(SHARED_DOWNLOAD_AUTHORIZATION_QUERY, &[&node_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(share) = share else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let share_id: String = share.get("id");
    let owner_id: String = share.get("owner_id");
    let root_node_id: String = share.get("root_node_id");
    let active_epoch: i64 = share.get("active_epoch");
    let share_record_version: i64 = share.get("record_version");
    let share_previous_record_hash: Option<Vec<u8>> = share.get("previous_record_hash");
    let recipient_key_version: i64 = share.get("recipient_key_version");
    let epoch_protocol_version: i16 = share.get("protocol_version");
    let epoch_wrapper_set_root: Option<Vec<u8>> = share.get("wrapper_set_root");
    let epoch_wrapper_count: Option<i32> = share.get("wrapper_count");
    let row = transaction
        .query_one(
            "
                SELECT files.entry_type, files.current_generation_number,
                       files.current_generation_id,
                       records.bootstrap_cbor, records.bootstrap_signature,
                       records.encrypted_manifest, records.signer_key_version,
                       heads.record_version, heads.record_hash,
                       signer.ed25519_public_key,
                       generations.object_key, generations.ciphertext_length,
                       generations.crypto_chunk_bytes, generations.chunk_count,
                       generations.ciphertext_merkle_root
                FROM files
                INNER JOIN vault_node_heads AS heads ON heads.node_id = files.id
                INNER JOIN vault_node_records AS records
                  ON records.node_id = heads.node_id
                 AND records.record_version = heads.record_version
                INNER JOIN vault_identity_keys AS signer
                  ON signer.user_id = records.owner_id
                 AND signer.key_version = records.signer_key_version
                LEFT JOIN vault_object_generations AS generations
                  ON generations.node_id = files.id
                 AND generations.generation_number = files.current_generation_number
                 AND generations.status = 'published'
                WHERE files.id = $1 AND files.owner_id = $2
            ",
            &[&node_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let generation_id: Vec<u8> = row.get("current_generation_id");
    let node_record_version: i64 = row.get("record_version");
    let wrapper_rows = transaction
        .query(
            "
                SELECT canonical_cbor, merkle_leaf_index, merkle_proof,
                       commitment_source
                FROM (
                  SELECT DISTINCT ON (wrapper_kind)
                         wrapper_kind, canonical_cbor, record_version,
                         merkle_leaf_index, merkle_proof, commitment_source
                  FROM vault_share_wrappers
                  WHERE share_id = $1 AND epoch = $2 AND node_id = $3
                    AND record_version = $5
                    AND (wrapper_kind = 'metadata'
                         OR (wrapper_kind = 'generation_dek' AND generation_id = $4))
                  ORDER BY wrapper_kind, record_version DESC, wrapper_id DESC
                ) AS current_wrappers
                ORDER BY wrapper_kind
            ",
            &[
                &share_id,
                &active_epoch,
                &node_id,
                &generation_id,
                &node_record_version,
            ],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let expected_wrapper_count = if row.get::<_, String>("entry_type") == "file" {
        2
    } else {
        1
    };
    if wrapper_rows.len() != expected_wrapper_count {
        return Ok(HttpResponse::Conflict().body("share material is still synchronizing"));
    }
    let envelope = transaction
        .query_one(
            "
                SELECT envelopes.canonical_cbor, envelopes.signature,
                       envelopes.envelope_hash, envelopes.sender_key_version,
                       envelopes.recipient_key_version, envelopes.sender_id,
                       envelopes.recipient_id, envelopes.node_id,
                       envelopes.record_version, envelopes.previous_record_hash,
                       sender.x25519_public_key, sender.ed25519_public_key,
                       sender.fingerprint_sha256
                FROM vault_share_envelopes AS envelopes
                INNER JOIN vault_identity_keys AS sender
                  ON sender.user_id = envelopes.sender_id
                 AND sender.key_version = envelopes.sender_key_version
                WHERE envelopes.share_id = $1 AND envelopes.epoch = $2
                  AND envelopes.recipient_id = $3
                ORDER BY envelopes.created_at DESC
                LIMIT 1
            ",
            &[&share_id, &active_epoch, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let envelope_sender_id: String = envelope.get("sender_id");
    let envelope_recipient_id: String = envelope.get("recipient_id");
    let envelope_node_id: String = envelope.get("node_id");
    let envelope_record_version: i64 = envelope.get("record_version");
    let envelope_previous_record_hash: Option<Vec<u8>> = envelope.get("previous_record_hash");
    let envelope_cbor: Vec<u8> = envelope.get("canonical_cbor");
    let decoded_envelope =
        decode_share_envelope(&envelope_cbor).map_err(error::ErrorInternalServerError)?;
    if envelope_sender_id != owner_id
        || envelope_recipient_id != user.id
        || envelope_node_id != root_node_id
        || envelope_record_version != share_record_version
        || envelope_previous_record_hash != share_previous_record_hash
        || i16::try_from(decoded_envelope.format_version).ok() != Some(epoch_protocol_version)
        || (epoch_protocol_version == SHARE_ENVELOPE_VERSION as i16
            && (decoded_envelope
                .wrapper_set_root
                .as_ref()
                .map(|value| value.as_slice())
                != epoch_wrapper_set_root.as_deref()
                || i32::try_from(decoded_envelope.wrapper_count).ok() != epoch_wrapper_count))
    {
        return Err(error::ErrorInternalServerError(
            "published share envelope is inconsistent with its active epoch",
        ));
    }
    let commitment_sources = wrapper_rows
        .iter()
        .map(|wrapper| wrapper.get::<_, String>("commitment_source"))
        .collect::<HashSet<_>>();
    if commitment_sources.len() != 1 {
        return Err(error::ErrorInternalServerError(
            "share wrappers use inconsistent commitments",
        ));
    }
    let uses_directory = commitment_sources.contains("directory");
    let directory_row = if uses_directory {
        transaction
            .query_opt(
                "
                    SELECT canonical_cbor, signature, wrapper_set_root,
                           wrapper_count, signer_key_version
                    FROM vault_share_wrapper_directories
                    WHERE node_id = $1 AND record_version = $2
                ",
                &[&node_id, &node_record_version],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
    } else {
        None
    };
    if uses_directory && directory_row.is_none() {
        return Err(error::ErrorInternalServerError(
            "share-wrapper directory is missing",
        ));
    }
    let object_key: Option<String> = row.get("object_key");
    let download_url = if let Some(object_key) = object_key.as_deref() {
        state
            .storage
            .download_url(object_key, "aeralyth-ciphertext.bin")
            .await
            .map_err(error::ErrorBadGateway)?
    } else {
        None
    };
    let bootstrap_cbor: Vec<u8> = row.get("bootstrap_cbor");
    let bootstrap = decode_bootstrap(&bootstrap_cbor).map_err(error::ErrorInternalServerError)?;
    let epoch_root = epoch_wrapper_set_root
        .as_deref()
        .map(<[u8; 32]>::try_from)
        .transpose()
        .map_err(|_| error::ErrorInternalServerError("stored wrapper root is invalid"))?;
    let directory_material = directory_row
        .as_ref()
        .map(|directory_row| -> Result<_> {
            let canonical_cbor: Vec<u8> = directory_row.get("canonical_cbor");
            let signature: Vec<u8> = directory_row.get("signature");
            let root: Vec<u8> = directory_row.get("wrapper_set_root");
            let root = <[u8; 32]>::try_from(root.as_slice())
                .map_err(|_| error::ErrorInternalServerError("stored directory root is invalid"))?;
            let count: i32 = directory_row.get("wrapper_count");
            let signer_key_version: i64 = directory_row.get("signer_key_version");
            let decoded =
                decode_share_directory(&canonical_cbor).map_err(error::ErrorInternalServerError)?;
            if decoded.node_id != node_id
                || i64::try_from(decoded.record_version).ok() != Some(node_record_version)
                || decoded.record_hash.as_slice() != row.get::<_, Vec<u8>>("record_hash")
                || decoded.generation_id.as_slice() != generation_id
                || i64::try_from(decoded.generation_number).ok()
                    != Some(row.get("current_generation_number"))
                || i64::try_from(decoded.signer_key_version).ok() != Some(signer_key_version)
                || decoded.wrapper_set_root != root
                || i32::try_from(decoded.wrapper_count).ok() != Some(count)
            {
                return Err(error::ErrorInternalServerError(
                    "stored share-wrapper directory is inconsistent",
                ));
            }
            verify_ed25519_signature(
                &canonical_cbor,
                &signature,
                row.get::<_, Vec<u8>>("ed25519_public_key").as_slice(),
            )
            .map_err(error::ErrorInternalServerError)?;
            Ok((canonical_cbor, signature, root, count))
        })
        .transpose()?;
    let mut wrappers = Vec::with_capacity(wrapper_rows.len());
    let mut wrapper_proofs = Vec::with_capacity(wrapper_rows.len());
    let mut directory_proofs = Vec::with_capacity(wrapper_rows.len());
    for wrapper in wrapper_rows {
        let canonical: Vec<u8> = wrapper.get("canonical_cbor");
        let wrapper_hash = sha256(&canonical);
        wrappers.push(encode_bytes(canonical));
        let leaf_index: Option<i32> = wrapper.get("merkle_leaf_index");
        let proof: Option<Vec<u8>> = wrapper.get("merkle_proof");
        let commitment_source: String = wrapper.get("commitment_source");
        let response_proof = match (commitment_source.as_str(), leaf_index, proof) {
            ("bootstrap" | "epoch", None, None) => None,
            (_, Some(leaf_index), Some(proof)) if proof.len() % 32 == 0 => {
                match commitment_source.as_str() {
                    "epoch" => {
                        if epoch_protocol_version != SHARE_ENVELOPE_VERSION as i16
                            || !verify_wrapper_set_proof(
                                wrapper_hash,
                                leaf_index,
                                &proof,
                                epoch_wrapper_count.unwrap_or_default(),
                                epoch_root.unwrap_or_default(),
                            )
                        {
                            return Err(error::ErrorInternalServerError(
                                "stored share wrapper proof does not match its epoch",
                            ));
                        }
                        Some(ShareWrapperProofResponse {
                            leaf_index,
                            proof: encode_bytes(proof),
                        })
                    }
                    "directory" => {
                        let Some((_, _, root, count)) = directory_material.as_ref() else {
                            return Err(error::ErrorInternalServerError(
                                "stored share directory proof is missing its directory",
                            ));
                        };
                        if !verify_wrapper_set_proof(
                            wrapper_hash,
                            leaf_index,
                            &proof,
                            *count,
                            *root,
                        ) {
                            return Err(error::ErrorInternalServerError(
                                "stored share wrapper proof does not match its directory",
                            ));
                        }
                        directory_proofs.push(ShareWrapperProofResponse {
                            leaf_index,
                            proof: encode_bytes(proof),
                        });
                        None
                    }
                    _ => {
                        return Err(error::ErrorInternalServerError(
                            "stored share wrapper commitment source is invalid",
                        ));
                    }
                }
            }
            _ => {
                return Err(error::ErrorInternalServerError(
                    "stored share wrapper proof is invalid",
                ));
            }
        };
        wrapper_proofs.push(response_proof);
    }
    let directory =
        directory_material.map(|(canonical_cbor, signature, _, _)| ShareDirectoryResponse {
            canonical_cbor: encode_bytes(canonical_cbor),
            signature: encode_bytes(signature),
            wrapper_proofs: directory_proofs,
        });
    let response = DownloadPlanResponse {
        node_id: node_id.to_owned(),
        entry_type: row.get("entry_type"),
        generation_number: row.get("current_generation_number"),
        generation_id: encode_bytes(generation_id),
        ciphertext_length: row.get::<_, Option<i64>>("ciphertext_length").unwrap_or(0),
        crypto_chunk_bytes: row
            .get::<_, Option<i32>>("crypto_chunk_bytes")
            .unwrap_or(CRYPTO_CHUNK_BYTES as i32),
        chunk_count: row.get::<_, Option<i32>>("chunk_count").unwrap_or(0),
        ciphertext_merkle_root: encode_bytes(
            row.get::<_, Option<Vec<u8>>>("ciphertext_merkle_root")
                .unwrap_or_else(|| bootstrap.ciphertext_merkle_root.to_vec()),
        ),
        download_url,
        bootstrap_cbor: encode_bytes(bootstrap_cbor),
        bootstrap_signature: encode_bytes(row.get::<_, Vec<u8>>("bootstrap_signature")),
        encrypted_manifest: encode_bytes(row.get::<_, Vec<u8>>("encrypted_manifest")),
        wrappers,
        signer_key_version: row.get("signer_key_version"),
        signer_ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
        record_version: row.get("record_version"),
        record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
        share: Some(ShareDownloadMaterial {
            share_id,
            epoch: active_epoch,
            root_node_id,
            sender_id: owner_id,
            recipient_id: user.id.clone(),
            record_version: share_record_version,
            previous_record_hash: share_previous_record_hash.map(encode_bytes),
            envelope_cbor: encode_bytes(envelope_cbor),
            envelope_signature: encode_bytes(envelope.get::<_, Vec<u8>>("signature")),
            envelope_hash: encode_bytes(envelope.get::<_, Vec<u8>>("envelope_hash")),
            sender_key_version: envelope.get("sender_key_version"),
            sender_x25519_public_key: encode_bytes(envelope.get::<_, Vec<u8>>("x25519_public_key")),
            sender_ed25519_public_key: encode_bytes(
                envelope.get::<_, Vec<u8>>("ed25519_public_key"),
            ),
            sender_fingerprint_sha256: encode_bytes(
                envelope.get::<_, Vec<u8>>("fingerprint_sha256"),
            ),
            recipient_key_version,
            wrapper_proofs,
            directory,
        }),
    };

    // Keep the share and recipient locks until the complete key plan and its
    // short-lived object URL have been assembled. Epoch rotation takes
    // conflicting row locks, so it cannot publish a revocation in the middle
    // of this authorization decision.
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(response))
}

async fn get_upload(
    state: &AppState,
    owner_id: &str,
    upload_id: &str,
) -> Result<Option<VaultUpload>> {
    let row = state
        .db
        .query_opt(
            "
                SELECT id, node_id, parent_id, entry_type,
                       generation_number, generation_id, object_key,
                       ciphertext_length, chunk_count, upload_mode,
                       part_size_bytes, multipart_upload_id, status,
                       checksum_sha256
                FROM vault_uploads
                WHERE id = $1 AND owner_id = $2
                LIMIT 1
            ",
            &[&upload_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    Ok(row.map(|row| VaultUpload {
        id: row.get("id"),
        node_id: row.get("node_id"),
        parent_id: row.get("parent_id"),
        entry_type: row.get("entry_type"),
        generation_number: row.get("generation_number"),
        generation_id: row.get("generation_id"),
        object_key: row.get("object_key"),
        ciphertext_length: row.get("ciphertext_length"),
        chunk_count: row.get("chunk_count"),
        mode: row.get("upload_mode"),
        part_size_bytes: row.get("part_size_bytes"),
        multipart_upload_id: row.get("multipart_upload_id"),
        status: row.get("status"),
        checksum_sha256: row.get("checksum_sha256"),
    }))
}

fn upload_plan(
    upload: &VaultUpload,
    existing_parts: Vec<crate::storage::UploadPartPlan>,
) -> VaultUploadPlanResponse {
    VaultUploadPlanResponse {
        upload_id: upload.id.clone(),
        node_id: upload.node_id.clone(),
        mode: upload.mode.clone(),
        part_size_bytes: upload
            .part_size_bytes
            .and_then(|value| u64::try_from(value).ok()),
        existing_parts,
    }
}

async fn validate_encrypted_parent(
    state: &AppState,
    user: &SessionPrincipal,
    parent_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(parent_id) = parent_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    validate_node_id(parent_id)?;
    let exists = state
        .db
        .query_opt(
            "
                SELECT 1 FROM files
                WHERE id = $1 AND owner_id = $2 AND entry_type = 'folder'
                  AND state = 'active' AND e2ee_state = 'encrypted'
            ",
            &[&parent_id, &user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if exists.is_none() {
        return Err(error::ErrorBadRequest("encrypted parent folder is invalid"));
    }
    Ok(Some(parent_id.to_owned()))
}

async fn require_configured_vault(state: &AppState, user: &SessionPrincipal) -> Result<()> {
    let configured = state
        .db
        .query_opt("SELECT 1 FROM user_vaults WHERE user_id = $1", &[&user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    if configured.is_none() {
        return Err(error::ErrorPreconditionFailed(
            "configure and unlock the encrypted vault first",
        ));
    }
    Ok(())
}

fn require_vault_enabled(state: &AppState) -> Result<()> {
    if !state.config.e2ee_mode.is_enabled() {
        return Err(error::ErrorNotFound("encrypted vault is disabled"));
    }
    Ok(())
}

async fn require_header_csrf(state: &AppState, request: &HttpRequest) -> Result<()> {
    let token = request
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    require_csrf(state, request, token).await
}

async fn migration_summary(state: &AppState, user: &SessionPrincipal) -> Result<MigrationSummary> {
    let row = state
        .db
        .query_one(
            "
                SELECT
                  (SELECT count(*)::bigint FROM files
                   WHERE owner_id = $1 AND e2ee_state = 'legacy') AS legacy_nodes,
                  (SELECT count(DISTINCT pending.node_id)::bigint
                   FROM (
                     SELECT id AS node_id FROM files
                     WHERE owner_id = $1 AND e2ee_state = 'staged'
                     UNION ALL
                     SELECT node_id FROM vault_migrations
                     WHERE owner_id = $1 AND state <> 'complete'
                   ) AS pending) AS incomplete_nodes
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let legacy_nodes: i64 = row.get("legacy_nodes");
    let incomplete_nodes: i64 = row.get("incomplete_nodes");
    Ok(MigrationSummary {
        legacy_nodes,
        incomplete_nodes,
        ready_for_required: legacy_nodes == 0 && incomplete_nodes == 0,
    })
}

struct SetupMaterial {
    kdf_salt: Vec<u8>,
    password_wrapper_id: Vec<u8>,
    password_root_ciphertext: Vec<u8>,
    recovery_salt: Vec<u8>,
    recovery_wrapper_id: Vec<u8>,
    recovery_root_ciphertext: Vec<u8>,
    identity_key_version: u64,
    x25519_public_key: Vec<u8>,
    ed25519_public_key: Vec<u8>,
    fingerprint_sha256: Vec<u8>,
    identity_record_id: Vec<u8>,
    identity_private_ciphertext: Vec<u8>,
    account_state_record_id: Option<Vec<u8>>,
    encrypted_account_state: Vec<u8>,
}

fn validate_setup_material(body: &VaultSetupRequest) -> Result<SetupMaterial> {
    if body.format_version != FORMAT_VERSION {
        return Err(error::ErrorBadRequest(
            "vault format version is unsupported",
        ));
    }
    validate_kdf(&body.kdf)?;
    if body.identity.key_version != 1 {
        return Err(error::ErrorBadRequest(
            "the first identity key version must be one",
        ));
    }
    Ok(SetupMaterial {
        kdf_salt: decode_fixed::<16>(&body.kdf.salt, "KDF salt")?.to_vec(),
        password_wrapper_id: decode_fixed::<16>(&body.password_wrapper.id, "password wrapper id")?
            .to_vec(),
        password_root_ciphertext: decode_fixed::<48>(
            &body.password_wrapper.ciphertext,
            "password root ciphertext",
        )?
        .to_vec(),
        recovery_salt: decode_fixed::<16>(&body.recovery_wrapper.salt, "recovery salt")?.to_vec(),
        recovery_wrapper_id: decode_fixed::<16>(&body.recovery_wrapper.id, "recovery wrapper id")?
            .to_vec(),
        recovery_root_ciphertext: decode_fixed::<48>(
            &body.recovery_wrapper.ciphertext,
            "recovery root ciphertext",
        )?
        .to_vec(),
        identity_key_version: body.identity.key_version,
        x25519_public_key: decode_fixed::<32>(
            &body.identity.x25519_public_key,
            "X25519 public key",
        )?
        .to_vec(),
        ed25519_public_key: decode_fixed::<32>(
            &body.identity.ed25519_public_key,
            "Ed25519 public key",
        )?
        .to_vec(),
        fingerprint_sha256: decode_fixed::<32>(
            &body.identity.fingerprint_sha256,
            "identity fingerprint",
        )?
        .to_vec(),
        identity_record_id: decode_fixed::<16>(
            &body.identity.private_record_id,
            "identity record id",
        )?
        .to_vec(),
        identity_private_ciphertext: decode_limited(
            &body.identity.private_ciphertext,
            MAX_IDENTITY_PRIVATE_CIPHERTEXT,
            "encrypted identity private keys",
        )?,
        account_state_record_id: decode_optional_fixed::<16>(
            body.account_state_record_id.as_deref(),
            "account state record id",
        )?
        .map(Vec::from),
        encrypted_account_state: decode_limited(
            body.encrypted_account_state.as_deref().unwrap_or(""),
            MAX_ACCOUNT_STATE_CIPHERTEXT,
            "encrypted account state",
        )?,
    })
}

fn validate_kdf(kdf: &KdfRequest) -> Result<()> {
    if kdf.algorithm != ARGON2ID_ALGORITHM
        || kdf.operations != ARGON2ID_OPERATIONS
        || kdf.memory_bytes != ARGON2ID_MEMORY_BYTES
        || kdf.output_bytes != ARGON2ID_OUTPUT_BYTES
    {
        return Err(error::ErrorBadRequest(
            "unsupported Argon2id parameters; this client must use the fixed moderate profile",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn rewrap_proof_message(
    expected_vault_version: i64,
    recovery: bool,
    kdf: &KdfRequest,
    kdf_salt: &[u8],
    password_wrapper_id: &[u8],
    password_ciphertext: &[u8],
    recovery_salt: &[u8],
    recovery_wrapper_id: &[u8],
    recovery_ciphertext: &[u8],
    account_state_record_id: Option<&[u8]>,
    encrypted_account_state: &[u8],
) -> Result<Vec<u8>> {
    let expected_vault_version = u64::try_from(expected_vault_version)
        .map_err(|_| error::ErrorBadRequest("vault version is invalid"))?;
    let mut output = b"aeralyth/vault-rewrap-proof/v1".to_vec();
    output.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    output.extend_from_slice(&expected_vault_version.to_be_bytes());
    output.push(u8::from(recovery));
    append_proof_field(&mut output, kdf.algorithm.as_bytes())?;
    append_proof_field(&mut output, kdf_salt)?;
    output.extend_from_slice(&kdf.operations.to_be_bytes());
    output.extend_from_slice(&kdf.memory_bytes.to_be_bytes());
    output.extend_from_slice(&kdf.output_bytes.to_be_bytes());
    append_proof_field(&mut output, password_wrapper_id)?;
    append_proof_field(&mut output, password_ciphertext)?;
    append_proof_field(&mut output, recovery_salt)?;
    append_proof_field(&mut output, recovery_wrapper_id)?;
    append_proof_field(&mut output, recovery_ciphertext)?;
    match account_state_record_id {
        Some(record_id) => {
            output.push(1);
            append_proof_field(&mut output, record_id)?;
        }
        None => output.push(0),
    }
    append_proof_field(&mut output, encrypted_account_state)?;
    Ok(output)
}

fn append_proof_field(output: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let length = u64::try_from(value.len())
        .map_err(|_| error::ErrorPayloadTooLarge("rewrap proof field is too large"))?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn validate_ciphertext_shape(entry_type: &str, ciphertext: u64, chunks: u64) -> Result<()> {
    match entry_type {
        "folder" if ciphertext == 0 && chunks == 0 => Ok(()),
        "file" if ciphertext > 16 && ciphertext <= MAX_CIPHERTEXT_BYTES && chunks > 0 => {
            let encrypted_payload = ciphertext
                .checked_sub(chunks.saturating_mul(16))
                .filter(|value| *value >= 4_096)
                .ok_or_else(|| error::ErrorBadRequest("ciphertext chunk layout is invalid"))?;
            if encrypted_payload.div_ceil(CRYPTO_CHUNK_BYTES) != chunks {
                return Err(error::ErrorBadRequest("ciphertext chunk layout is invalid"));
            }
            Ok(())
        }
        "file" => Err(error::ErrorBadRequest("ciphertext shape is invalid")),
        _ => Err(error::ErrorBadRequest("entry type is invalid")),
    }
}

fn validate_node_id(node_id: &str) -> Result<()> {
    if !(8..=96).contains(&node_id.len())
        || !node_id.starts_with("fil_")
        || !node_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(error::ErrorBadRequest("node id is invalid"));
    }
    Ok(())
}

fn validate_prefixed_id(value: &str, prefix: &str, label: &str) -> Result<()> {
    if !(8..=96).contains(&value.len())
        || !value.starts_with(prefix)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(error::ErrorBadRequest(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_sha256_checksum(value: &str) -> Result<String> {
    let value = value.trim();
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| error::ErrorBadRequest("SHA-256 checksum is invalid"))?;
    if decoded.len() != 32 {
        return Err(error::ErrorBadRequest("SHA-256 checksum is invalid"));
    }
    Ok(value.to_owned())
}

fn identity_fingerprint(x25519: &[u8], ed25519: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(x25519.len() + ed25519.len());
    input.extend_from_slice(x25519);
    input.extend_from_slice(ed25519);
    sha256(&input).to_vec()
}

fn decode_fixed<const SIZE: usize>(value: &str, label: &str) -> Result<[u8; SIZE]> {
    URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| error::ErrorBadRequest(format!("{label} is not valid base64url")))?
        .try_into()
        .map_err(|_| error::ErrorBadRequest(format!("{label} has an invalid length")))
}

fn decode_optional_fixed<const SIZE: usize>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<[u8; SIZE]>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| decode_fixed::<SIZE>(value, label))
        .transpose()
}

fn decode_limited(value: &str, maximum: usize, label: &str) -> Result<Vec<u8>> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| error::ErrorBadRequest(format!("{label} is not valid base64url")))?;
    if decoded.len() > maximum {
        return Err(error::ErrorPayloadTooLarge(format!("{label} is too large")));
    }
    Ok(decoded)
}

fn encode_bytes(value: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

fn random_id() -> Result<String> {
    let mut bytes = [0_u8; 18];
    getrandom::fill(&mut bytes).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    #[test]
    fn validates_encrypted_chunk_layouts() {
        assert!(validate_ciphertext_shape("folder", 0, 0).is_ok());
        assert!(validate_ciphertext_shape("file", 4_112, 1).is_ok());
        assert!(validate_ciphertext_shape("file", CRYPTO_CHUNK_BYTES + 16, 1).is_ok());
        assert!(validate_ciphertext_shape("file", 4_096, 1).is_err());
        assert!(validate_ciphertext_shape("file", 4_112, 2).is_err());
        assert!(validate_ciphertext_shape("folder", 4_112, 1).is_err());
    }

    #[test]
    fn rejects_stale_or_replaced_node_heads() {
        let current_hash = [9_u8; 32];
        let successor = bootstrap_for_cas(2, Some(current_hash));
        assert!(validate_head_cas(1, &current_hash, &successor).is_ok());

        let stale = bootstrap_for_cas(1, None);
        assert!(validate_head_cas(1, &current_hash, &stale).is_err());

        let replacement = bootstrap_for_cas(2, Some([8_u8; 32]));
        assert!(validate_head_cas(1, &current_hash, &replacement).is_err());
    }

    #[test]
    fn share_snapshot_hash_commits_order_and_node_heads() {
        let first = SnapshotNode {
            node_id: "fil_alpha".to_owned(),
            entry_type: "folder".to_owned(),
            generation_number: 1,
            generation_id: None,
            record_version: 1,
            record_hash: vec![1_u8; 32],
        };
        let second = SnapshotNode {
            node_id: "fil_beta".to_owned(),
            entry_type: "file".to_owned(),
            generation_number: 2,
            generation_id: Some(vec![2_u8; 16]),
            record_version: 3,
            record_hash: vec![3_u8; 32],
        };
        let ordered = snapshot_hash(&[clone_snapshot(&first), clone_snapshot(&second)]);
        let reordered = snapshot_hash(&[clone_snapshot(&second), clone_snapshot(&first)]);
        assert_ne!(ordered, reordered);

        let mut changed = clone_snapshot(&second);
        changed.record_hash[0] ^= 1;
        assert_ne!(ordered, snapshot_hash(&[clone_snapshot(&first), changed]));
    }

    #[test]
    fn rewrap_proof_rejects_field_changes() {
        let kdf = KdfRequest {
            algorithm: ARGON2ID_ALGORITHM.to_owned(),
            salt: encode_bytes([1_u8; 16]),
            operations: ARGON2ID_OPERATIONS,
            memory_bytes: ARGON2ID_MEMORY_BYTES,
            output_bytes: ARGON2ID_OUTPUT_BYTES,
        };
        let proof = rewrap_proof_message(
            7,
            true,
            &kdf,
            &[1_u8; 16],
            &[2_u8; 16],
            &[3_u8; 48],
            &[4_u8; 16],
            &[5_u8; 16],
            &[6_u8; 48],
            Some(&[7_u8; 16]),
            &[8_u8; 64],
        )
        .unwrap();
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let signature = signing_key.sign(&proof).to_bytes();
        assert!(
            verify_ed25519_signature(&proof, &signature, &signing_key.verifying_key().to_bytes(),)
                .is_ok()
        );

        let changed = rewrap_proof_message(
            8,
            true,
            &kdf,
            &[1_u8; 16],
            &[2_u8; 16],
            &[3_u8; 48],
            &[4_u8; 16],
            &[5_u8; 16],
            &[6_u8; 48],
            Some(&[7_u8; 16]),
            &[8_u8; 64],
        )
        .unwrap();
        assert!(
            verify_ed25519_signature(
                &changed,
                &signature,
                &signing_key.verifying_key().to_bytes(),
            )
            .is_err()
        );
    }

    #[test]
    fn shared_download_authorization_locks_revocation_rows() {
        assert!(
            SHARED_DOWNLOAD_AUTHORIZATION_QUERY.contains("FOR SHARE OF shares, recipients"),
            "shared key plans must hold locks that conflict with epoch rotation"
        );
        assert!(SHARED_DOWNLOAD_AUTHORIZATION_QUERY.contains("recipients.status = 'active'"));
        assert!(SHARED_DOWNLOAD_AUTHORIZATION_QUERY.contains("shares.status = 'active'"));
    }

    #[test]
    fn share_record_hash_reuses_the_commitments_canonical_wrapper_order() {
        let wrapper_hashes = [[3_u8; 32], [1_u8; 32], [2_u8; 32]];
        let commitment = wrapper_set_commitment(&wrapper_hashes).unwrap();
        let snapshot = [9_u8; 32];
        let actual = share_record_hash(&snapshot, &commitment, &[], 7);

        let mut expected_input = b"aeralyth/share-record/v1".to_vec();
        expected_input.extend_from_slice(&7_i64.to_be_bytes());
        expected_input.extend_from_slice(&snapshot);
        let mut ordered = wrapper_hashes;
        ordered.sort_unstable();
        for hash in ordered {
            expected_input.extend_from_slice(&hash);
        }

        assert_eq!(actual, sha256(&expected_input));
        assert!(
            commitment
                .proofs
                .windows(2)
                .all(|pair| pair[0].wrapper_hash < pair[1].wrapper_hash)
        );
    }

    #[test]
    fn protocol_v2_envelopes_reuse_one_precomputed_wrapper_commitment() {
        let commitment = wrapper_set_commitment(&[[4_u8; 32], [5_u8; 32]]).unwrap();
        for index in 0..128 {
            let recipient = format!("usr_recipient_{index}");
            let envelope = envelope_for_test(&recipient, &commitment);
            assert!(
                validate_envelope(
                    &envelope,
                    &commitment,
                    "shr_test",
                    2,
                    "usr_sender",
                    3,
                    &recipient,
                    4,
                    "fil_root",
                    1,
                    None,
                )
                .is_ok()
            );
        }

        let mut legacy = envelope_for_test("usr_legacy", &commitment);
        legacy.record.format_version = FORMAT_VERSION;
        legacy.record.wrapper_hashes = vec![[4_u8; 32], [5_u8; 32]];
        legacy.record.wrapper_set_root = None;
        assert!(
            validate_envelope(
                &legacy,
                &commitment,
                "shr_test",
                2,
                "usr_sender",
                3,
                "usr_legacy",
                4,
                "fil_root",
                1,
                None,
            )
            .is_err()
        );
    }

    fn bootstrap_for_cas(
        record_version: u64,
        previous_record_hash: Option<[u8; 32]>,
    ) -> crate::e2ee::BootstrapRecord {
        crate::e2ee::BootstrapRecord {
            format_version: FORMAT_VERSION,
            suite_id: 1,
            aad_schema_id: 1,
            node_id: "fil_test".to_owned(),
            generation_number: 1,
            generation_id: [1_u8; 16],
            manifest_iv: [0_u8; 12],
            wrapper_ids: vec![[2_u8; 16]],
            ciphertext_length: 4_112,
            signer_key_version: 1,
            record_version,
            previous_record_hash,
            manifest_hash: [3_u8; 32],
            wrapper_hashes: vec![[4_u8; 32]],
            ciphertext_merkle_root: [5_u8; 32],
        }
    }

    fn clone_snapshot(node: &SnapshotNode) -> SnapshotNode {
        SnapshotNode {
            node_id: node.node_id.clone(),
            entry_type: node.entry_type.clone(),
            generation_number: node.generation_number,
            generation_id: node.generation_id.clone(),
            record_version: node.record_version,
            record_hash: node.record_hash.clone(),
        }
    }

    fn envelope_for_test(
        recipient_id: &str,
        commitment: &WrapperSetCommitment,
    ) -> ShareEnvelopeMaterial {
        ShareEnvelopeMaterial {
            canonical: Vec::new(),
            signature: Vec::new(),
            record: crate::e2ee::ShareEnvelopeRecord {
                format_version: SHARE_ENVELOPE_VERSION,
                suite_id: 1,
                envelope_id: [1_u8; 16],
                share_id: "shr_test".to_owned(),
                epoch: 2,
                sender_id: "usr_sender".to_owned(),
                sender_key_version: 3,
                recipient_id: recipient_id.to_owned(),
                recipient_key_version: 4,
                node_id: "fil_root".to_owned(),
                permissions: 1,
                generation_scope: None,
                record_version: 1,
                previous_record_hash: None,
                encapsulated_key: [2_u8; 32],
                ciphertext: vec![3_u8; 48],
                aad_schema_id: 1,
                wrapper_hashes: Vec::new(),
                wrapper_set_root: Some(commitment.root),
                wrapper_count: commitment.count as u64,
            },
            hash: [6_u8; 32],
        }
    }
}
