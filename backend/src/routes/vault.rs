use std::collections::{HashMap, HashSet};

use actix_web::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use actix_web::{HttpRequest, HttpResponse, Result, error, web};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bytes::{Bytes, BytesMut};
use futures_util::{StreamExt, future::try_join_all};
use serde::{Deserialize, Serialize};
use tokio_postgres::IsolationLevel;

use crate::auth::{SessionPrincipal, parse_json_body, require_csrf, require_principal};
use crate::config::E2eeMode;
use crate::db::{query_one_cached, query_opt_cached};
use crate::e2ee::{
    ARGON2ID_ALGORITHM, ARGON2ID_MEMORY_BYTES, ARGON2ID_OPERATIONS, ARGON2ID_OUTPUT_BYTES,
    CRYPTO_CHUNK_BYTES, DecodedWrapper, FORMAT_VERSION, MAX_CIPHERTEXT_BYTES,
    SHARE_DIRECTORY_VERSION, SHARE_ENVELOPE_VERSION, UPLOAD_PART_BYTES, WrapperSetCommitment,
    decode_bootstrap, decode_share_directory, decode_share_envelope, decode_wrapper_material,
    sha256, uses_vault_multipart_upload, verify_decoded_node_record, verify_ed25519_signature,
    verify_share_envelope, verify_wrapper_set_proof, wrapper_set_commitment,
};
use crate::routes::pagination::{decode_cursor, encode_cursor, row_limit};
use crate::routes::tree_walk::{
    MAX_TREE_MUTATION_NODES, TREE_MUTATION_BATCH_SIZE, TreeWalkScope, walk_subtree,
};
use crate::routes::upload_reservations::{reservation_amount, reserve_upload_capacity};
use crate::state::{AppState, VaultValidationError};
use crate::storage::{ObjectMetadata, UploadedPart};
use crate::timestamps;
use crate::vault_wire::{
    self, CreateSharePublication, NodePublication, OwnerEpochKey, PublishEpochPublication,
    ShareDirectoryPublication, SignedEnvelope,
};

const MAX_IDENTITY_PRIVATE_CIPHERTEXT: usize = 8_192;
const VAULT_SHARE_PAGE_SIZE: usize = 100;
const MAX_ACCOUNT_STATE_CIPHERTEXT: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_CIPHERTEXT: usize = 1024 * 1024;
const MAX_PRESIGN_PARTS: usize = 32;
const VAULT_CONTROL_JSON_LIMIT: usize = 64 * 1024;
const VAULT_ACCOUNT_JSON_LIMIT: usize = 6 * 1024 * 1024;
const VAULT_PUBLISH_JSON_LIMIT: usize = 8 * 1024 * 1024;
const MAX_METADATA_PLAN_REQUEST_NODES: usize = 100;
const MAX_METADATA_PLAN_EXPANDED_NODES: usize = 512;
const SHARED_METADATA_PLAN_CONCURRENCY: usize = 8;
const VAULT_PUBLICATION_CONTENT_TYPE: &str = "application/vnd.aeralyth.vault-publication";
const OWNED_METADATA_PLANS_QUERY: &str = "
    WITH RECURSIVE requested AS (
      SELECT node_id, ordinality::bigint AS ordinal
      FROM unnest($1::text[]) WITH ORDINALITY AS input(node_id, ordinality)
    ), owned_tree AS (
      SELECT files.id, files.parent_id, requested.ordinal,
             0::integer AS depth, ARRAY[files.id]::text[] AS visited_ids
      FROM requested
      INNER JOIN files ON files.id = requested.node_id
      WHERE files.owner_id = $2
        AND files.state = 'active'
        AND files.e2ee_state = 'encrypted'

      UNION ALL

      SELECT parent.id, parent.parent_id, child.ordinal,
             child.depth + 1, child.visited_ids || parent.id
      FROM owned_tree AS child
      INNER JOIN files AS parent ON parent.id = child.parent_id
      WHERE parent.owner_id = $2
        AND parent.state = 'active'
        AND parent.e2ee_state = 'encrypted'
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    ), candidates AS (
      SELECT id, min(ordinal) AS ordinal, max(depth) AS depth
      FROM owned_tree
      GROUP BY id
    )
    SELECT candidates.depth, candidates.ordinal,
           files.id, files.entry_type, files.current_generation_number,
           files.current_generation_id,
           records.bootstrap_cbor, records.bootstrap_signature,
           records.encrypted_manifest, records.signer_key_version,
           heads.record_version, heads.record_hash,
           identity.ed25519_public_key
    FROM candidates
    INNER JOIN files ON files.id = candidates.id
    INNER JOIN vault_node_heads AS heads ON heads.node_id = files.id
    INNER JOIN vault_node_records AS records
      ON records.node_id = heads.node_id
     AND records.record_version = heads.record_version
    INNER JOIN vault_identity_keys AS identity
      ON identity.user_id = records.owner_id
     AND identity.key_version = records.signer_key_version
    ORDER BY candidates.depth DESC, candidates.ordinal, files.id
";
const OWNED_METADATA_WRAPPERS_QUERY: &str = "
    SELECT wrappers.node_id, wrappers.record_version,
           array_agg(wrappers.canonical_cbor ORDER BY wrappers.wrapper_id) AS wrapper_cbors
    FROM vault_wrappers AS wrappers
    INNER JOIN vault_node_heads AS heads
      ON heads.node_id = wrappers.node_id
     AND heads.record_version = wrappers.record_version
    WHERE wrappers.node_id = ANY($1)
    GROUP BY wrappers.node_id, wrappers.record_version
";
const SHARED_DOWNLOAD_SNAPSHOT_QUERY: &str = "
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
             0::integer AS depth FROM files
      WHERE id = $1 AND state = 'active' AND e2ee_state = 'encrypted'
      UNION ALL
      SELECT parent.id, parent.parent_id,
             child.visited_ids || parent.id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.state = 'active' AND parent.e2ee_state = 'encrypted'
        AND child.depth < 100
        AND NOT parent.id = ANY(child.visited_ids)
    ), authorized_share AS MATERIALIZED (
      SELECT shares.id AS share_id, shares.owner_id, shares.root_node_id,
             shares.active_epoch, shares.record_version AS share_record_version,
             shares.previous_record_hash AS share_previous_record_hash,
             recipients.recipient_key_version,
             epochs.protocol_version AS epoch_protocol_version,
             epochs.wrapper_set_root AS epoch_wrapper_set_root,
             epochs.wrapper_count AS epoch_wrapper_count
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
    ), node AS MATERIALIZED (
      SELECT files.entry_type, files.current_generation_number,
             files.current_generation_id,
             records.bootstrap_cbor, records.bootstrap_signature,
             records.encrypted_manifest, records.signer_key_version,
             heads.record_version AS node_record_version, heads.record_hash,
             signer.ed25519_public_key AS node_signer_ed25519_public_key,
             generations.object_key, generations.ciphertext_length,
             generations.crypto_chunk_bytes, generations.chunk_count,
             generations.ciphertext_merkle_root
      FROM authorized_share
      INNER JOIN files
        ON files.id = $1
       AND files.owner_id = authorized_share.owner_id
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
    ), current_wrappers AS MATERIALIZED (
      SELECT DISTINCT ON (wrappers.wrapper_kind)
             wrappers.wrapper_kind, wrappers.canonical_cbor,
             wrappers.merkle_leaf_index, wrappers.merkle_proof,
             wrappers.commitment_source
      FROM authorized_share
      CROSS JOIN node
      INNER JOIN vault_share_wrappers AS wrappers
        ON wrappers.share_id = authorized_share.share_id
       AND wrappers.epoch = authorized_share.active_epoch
       AND wrappers.node_id = $1
       AND wrappers.record_version = node.node_record_version
       AND (
         wrappers.wrapper_kind = 'metadata'
         OR (
           wrappers.wrapper_kind = 'generation_dek'
           AND wrappers.generation_id = node.current_generation_id
         )
       )
      ORDER BY wrappers.wrapper_kind,
               wrappers.record_version DESC,
               wrappers.wrapper_id DESC
    ), wrapper_snapshot AS MATERIALIZED (
      SELECT
        COALESCE(
          array_agg(canonical_cbor ORDER BY wrapper_kind),
          ARRAY[]::bytea[]
        ) AS wrapper_cbors,
        COALESCE(
          array_agg(merkle_leaf_index ORDER BY wrapper_kind),
          ARRAY[]::integer[]
        ) AS wrapper_leaf_indexes,
        COALESCE(
          array_agg(merkle_proof ORDER BY wrapper_kind),
          ARRAY[]::bytea[]
        ) AS wrapper_merkle_proofs,
        COALESCE(
          array_agg(commitment_source ORDER BY wrapper_kind),
          ARRAY[]::text[]
        ) AS wrapper_commitment_sources
      FROM current_wrappers
    )
    SELECT authorized_share.*,
           node.*,
           wrapper_snapshot.*,
           envelope.canonical_cbor AS envelope_cbor,
           envelope.signature AS envelope_signature,
           envelope.envelope_hash,
           envelope.sender_key_version AS envelope_sender_key_version,
           envelope.recipient_key_version AS envelope_recipient_key_version,
           envelope.sender_id AS envelope_sender_id,
           envelope.recipient_id AS envelope_recipient_id,
           envelope.node_id AS envelope_node_id,
           envelope.record_version AS envelope_record_version,
           envelope.previous_record_hash AS envelope_previous_record_hash,
           envelope.x25519_public_key AS envelope_sender_x25519_public_key,
           envelope.ed25519_public_key AS envelope_sender_ed25519_public_key,
           envelope.fingerprint_sha256 AS envelope_sender_fingerprint_sha256,
           directory.canonical_cbor AS directory_cbor,
           directory.signature AS directory_signature,
           directory.wrapper_set_root AS directory_wrapper_set_root,
           directory.wrapper_count AS directory_wrapper_count,
           directory.signer_key_version AS directory_signer_key_version
    FROM authorized_share
    CROSS JOIN node
    CROSS JOIN wrapper_snapshot
    LEFT JOIN LATERAL (
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
      WHERE envelopes.share_id = authorized_share.share_id
        AND envelopes.epoch = authorized_share.active_epoch
        AND envelopes.recipient_id = $2
      ORDER BY envelopes.created_at DESC, envelopes.envelope_id DESC
      LIMIT 1
    ) AS envelope ON TRUE
    LEFT JOIN vault_share_wrapper_directories AS directory
      ON directory.node_id = $1
     AND directory.record_version = node.node_record_version
";
const MIGRATION_CLAIM_QUERY: &str = "
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
";
const MIGRATION_SUMMARY_QUERY: &str = "
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
struct MetadataPlanResponse {
    node_id: String,
    entry_type: String,
    generation_number: i64,
    generation_id: String,
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

impl From<DownloadPlanResponse> for MetadataPlanResponse {
    fn from(plan: DownloadPlanResponse) -> Self {
        Self {
            node_id: plan.node_id,
            entry_type: plan.entry_type,
            generation_number: plan.generation_number,
            generation_id: plan.generation_id,
            bootstrap_cbor: plan.bootstrap_cbor,
            bootstrap_signature: plan.bootstrap_signature,
            encrypted_manifest: plan.encrypted_manifest,
            wrappers: plan.wrappers,
            signer_key_version: plan.signer_key_version,
            signer_ed25519_public_key: plan.signer_ed25519_public_key,
            record_version: plan.record_version,
            record_hash: plan.record_hash,
            share: plan.share,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataPlansRequest {
    node_ids: Vec<String>,
}

#[derive(Serialize)]
struct MetadataPlansResponse {
    plans: Vec<MetadataPlanResponse>,
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

struct SharedWrapperSnapshot {
    canonical_cbor: Vec<u8>,
    merkle_leaf_index: Option<i32>,
    merkle_proof: Option<Vec<u8>>,
    commitment_source: String,
}

struct SharedEnvelopeSnapshot {
    canonical_cbor: Vec<u8>,
    signature: Vec<u8>,
    envelope_hash: Vec<u8>,
    sender_key_version: i64,
    recipient_key_version: i64,
    sender_id: String,
    recipient_id: String,
    node_id: String,
    record_version: i64,
    previous_record_hash: Option<Vec<u8>>,
    sender_x25519_public_key: Vec<u8>,
    sender_ed25519_public_key: Vec<u8>,
    sender_fingerprint_sha256: Vec<u8>,
}

struct SharedDirectorySnapshot {
    canonical_cbor: Vec<u8>,
    signature: Vec<u8>,
    wrapper_set_root: Vec<u8>,
    wrapper_count: i32,
    signer_key_version: i64,
}

struct SharedDownloadSnapshot {
    share_id: String,
    owner_id: String,
    root_node_id: String,
    active_epoch: i64,
    share_record_version: i64,
    share_previous_record_hash: Option<Vec<u8>>,
    recipient_key_version: i64,
    epoch_protocol_version: i16,
    epoch_wrapper_set_root: Option<Vec<u8>>,
    epoch_wrapper_count: Option<i32>,
    entry_type: String,
    current_generation_number: i64,
    current_generation_id: Vec<u8>,
    bootstrap_cbor: Vec<u8>,
    bootstrap_signature: Vec<u8>,
    encrypted_manifest: Vec<u8>,
    signer_key_version: i64,
    node_record_version: i64,
    record_hash: Vec<u8>,
    node_signer_ed25519_public_key: Vec<u8>,
    ciphertext_length: Option<i64>,
    crypto_chunk_bytes: Option<i32>,
    chunk_count: Option<i32>,
    ciphertext_merkle_root: Option<Vec<u8>>,
    wrappers: Vec<SharedWrapperSnapshot>,
    envelope: SharedEnvelopeSnapshot,
    directory: Option<SharedDirectorySnapshot>,
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
    #[serde(skip)]
    cursor_created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedSharesQuery {
    root_node_id: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct OwnedSharesCursor {
    scope: String,
    root_node_id: Option<String>,
    created_at: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedSharesResponse {
    shares: Vec<OwnedShareResponse>,
    next_cursor: Option<String>,
    has_more: bool,
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

type ShareWrapperMaterial = DecodedWrapper;

struct ShareEnvelopeMaterial {
    canonical: Bytes,
    signature: Bytes,
    record: crate::e2ee::ShareEnvelopeRecord,
    hash: [u8; 32],
}

struct OwnerEpochKeyMaterial {
    wrapper_id: [u8; 16],
    ciphertext: [u8; 48],
}

type EpochRecipientMaterial = (String, i64, Vec<u8>, Vec<u8>, Vec<u8>);

#[derive(Eq, PartialEq)]
struct EpochPublicationSnapshot {
    root_node_id: String,
    active_epoch: i64,
    pending_epoch: Option<i64>,
    publication_fenced: bool,
    fence_snapshot_hash: Option<Vec<u8>>,
    record_version: i64,
    record_hash: Option<Vec<u8>>,
    revoked_recipient_id: String,
    retained_recipients: Vec<(String, i64)>,
    nodes: Vec<SnapshotNode>,
}

#[derive(Eq, PartialEq)]
struct ShareDirectorySnapshot {
    record_version: i64,
    entry_type: String,
    generation_number: i64,
    generation_id: Vec<u8>,
    record_hash: Vec<u8>,
    signer_key_version: i64,
    signer_public_key: Vec<u8>,
    shares: Vec<(String, i64)>,
}

#[derive(Eq, PartialEq)]
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
    bootstrap_cbor: Bytes,
    signature: Bytes,
    encrypted_manifest: Bytes,
    wrappers: Vec<DecodedWrapper>,
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
        .query_opt(MIGRATION_CLAIM_QUERY, &[&user.id])
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
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let body =
        parse_json_body::<VaultSetupRequest>(&request, body, VAULT_ACCOUNT_JSON_LIMIT).await?;
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
    state.db.release_request_connection().await;
    let response = run_publication_decode(&state, &user.id, move || {
        encode_json_response(&UnlockMaterialResponse {
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
                private_ciphertext: encode_bytes(
                    row.get::<_, Vec<u8>>("identity_private_ciphertext"),
                ),
            },
            account_state_record_id: row
                .get::<_, Option<Vec<u8>>>("account_state_record_id")
                .map(encode_bytes),
            encrypted_account_state: encode_bytes(row.get::<_, Vec<u8>>("encrypted_account_state")),
        })
    })
    .await?;

    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(response))
}

pub async fn rewrap(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let body =
        parse_json_body::<VaultRewrapRequest>(&request, body, VAULT_ACCOUNT_JSON_LIMIT).await?;
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
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<TrustIdentityRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
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
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<VaultUploadInitRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
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
    body: web::Payload,
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
    let body = parse_json_body::<ChecksumRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
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
    body: web::Payload,
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
    let body = parse_json_body::<ChecksumRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
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
    body: web::Payload,
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
    let body =
        parse_json_body::<PartChecksumsRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
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
    body: web::Payload,
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
    state.db.release_request_connection().await;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let mut body = parse_node_publication(&state, &user.id, &request, body, true).await?;
    let requested_parts = std::mem::take(&mut body.parts);
    let upload_mode = upload.mode.clone();
    let ciphertext_length = upload.ciphertext_length;
    let completed_parts = run_publication_decode(&state, &user.id, move || {
        validate_completed_parts(upload_mode, ciphertext_length, requested_parts)
            .map_err(portable_publication_error)
    })
    .await?;
    let decoded = decode_and_verify_node_record(&state, &user, body).await?;
    validate_record_for_upload(&decoded, &upload)?;
    let metadata = finalize_ciphertext_object(&state, &user, &upload, &completed_parts).await?;
    let response =
        publish_record_transaction(&state, &user, &upload, &decoded, metadata.as_ref()).await?;

    Ok(HttpResponse::Created().json(response))
}

pub async fn publish_record(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    state.db.release_request_connection().await;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let body = parse_node_publication(&state, &user.id, &request, body, false).await?;
    let decoded = decode_and_verify_node_record(&state, &user, body).await?;
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
    insert_share_wrappers(&transaction, committed_share_wrappers.iter().copied(), None).await?;
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

pub async fn metadata_plans(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<MetadataPlansRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT).await?;
    if body.node_ids.is_empty() || body.node_ids.len() > MAX_METADATA_PLAN_REQUEST_NODES {
        return Err(error::ErrorBadRequest(
            "metadata plan request must contain between 1 and 100 node ids",
        ));
    }
    let mut unique_ids = HashSet::with_capacity(body.node_ids.len());
    for node_id in &body.node_ids {
        validate_node_id(node_id)?;
        if !unique_ids.insert(node_id.as_str()) {
            return Err(error::ErrorBadRequest(
                "metadata plan request contains duplicate node ids",
            ));
        }
    }

    let owned_rows = state
        .db
        .query(OWNED_METADATA_PLANS_QUERY, &[&body.node_ids, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    if owned_rows.len() > MAX_METADATA_PLAN_EXPANDED_NODES {
        return Err(error::ErrorPayloadTooLarge(
            "metadata plan ancestry exceeds the bounded batch limit",
        ));
    }
    let owned_node_ids = owned_rows
        .iter()
        .map(|row| row.get::<_, String>("id"))
        .collect::<HashSet<_>>();
    let wrapper_node_ids = owned_node_ids.iter().cloned().collect::<Vec<_>>();
    let wrapper_rows = if wrapper_node_ids.is_empty() {
        Vec::new()
    } else {
        state
            .db
            .query(OWNED_METADATA_WRAPPERS_QUERY, &[&wrapper_node_ids])
            .await
            .map_err(error::ErrorInternalServerError)?
    };
    state.db.release_request_connection().await;

    let mut wrappers = HashMap::with_capacity(wrapper_rows.len());
    for row in wrapper_rows {
        wrappers.insert(
            (
                row.get::<_, String>("node_id"),
                row.get::<_, i64>("record_version"),
            ),
            row.get::<_, Vec<Vec<u8>>>("wrapper_cbors"),
        );
    }
    let mut plans = run_publication_decode(&state, &user.id, move || {
        Ok::<_, (u16, String)>(
            owned_rows
                .into_iter()
                .map(|row| {
                    let key = (
                        row.get::<_, String>("id"),
                        row.get::<_, i64>("record_version"),
                    );
                    owned_metadata_plan_from_row(row, wrappers.remove(&key).unwrap_or_default())
                })
                .collect::<Vec<_>>(),
        )
    })
    .await?;

    let shared_node_ids = body
        .node_ids
        .iter()
        .filter(|node_id| !owned_node_ids.contains(node_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for chunk in shared_node_ids.chunks(SHARED_METADATA_PLAN_CONCURRENCY) {
        let loaded = try_join_all(
            chunk
                .iter()
                .map(|node_id| load_shared_metadata_plan(&state, &user, node_id)),
        )
        .await?;
        plans.extend(loaded.into_iter().flatten());
    }

    let response = MetadataPlansResponse { plans };
    let body =
        run_publication_decode(&state, &user.id, move || encode_json_response(&response)).await?;
    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(body))
}

fn owned_metadata_plan_from_row(
    row: tokio_postgres::Row,
    wrapper_cbors: Vec<Vec<u8>>,
) -> MetadataPlanResponse {
    let bootstrap_cbor: Vec<u8> = row.get("bootstrap_cbor");
    MetadataPlanResponse {
        node_id: row.get("id"),
        entry_type: row.get("entry_type"),
        generation_number: row.get("current_generation_number"),
        generation_id: encode_bytes(row.get::<_, Vec<u8>>("current_generation_id")),
        bootstrap_cbor: encode_bytes(bootstrap_cbor),
        bootstrap_signature: encode_bytes(row.get::<_, Vec<u8>>("bootstrap_signature")),
        encrypted_manifest: encode_bytes(row.get::<_, Vec<u8>>("encrypted_manifest")),
        wrappers: wrapper_cbors.into_iter().map(encode_bytes).collect(),
        signer_key_version: row.get("signer_key_version"),
        signer_ed25519_public_key: encode_bytes(row.get::<_, Vec<u8>>("ed25519_public_key")),
        record_version: row.get("record_version"),
        record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
        share: None,
    }
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
    let wrapper_rows = state
        .db
        .query(
            "SELECT canonical_cbor FROM vault_wrappers WHERE node_id = $1 AND record_version = $2 ORDER BY wrapper_id",
            &[&node_id, &record_version],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let object_key: Option<String> = row.get("object_key");
    state.db.release_request_connection().await;
    let download_url = if let Some(object_key) = object_key.as_deref() {
        state
            .storage
            .download_url(object_key, "aeralyth-ciphertext.bin")
            .await
            .map_err(error::ErrorBadGateway)?
    } else {
        None
    };
    let response = run_publication_decode(&state, &user.id, move || {
        let response: Result<DownloadPlanResponse> = (|| {
            let wrappers = wrapper_rows
                .into_iter()
                .map(|row| encode_bytes(row.get::<_, Vec<u8>>("canonical_cbor")))
                .collect::<Vec<_>>();
            let bootstrap_cbor: Vec<u8> = row.get("bootstrap_cbor");
            let bootstrap =
                decode_bootstrap(&bootstrap_cbor).map_err(error::ErrorInternalServerError)?;
            Ok(DownloadPlanResponse {
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
                signer_ed25519_public_key: encode_bytes(
                    row.get::<_, Vec<u8>>("ed25519_public_key"),
                ),
                record_version,
                record_hash: encode_bytes(row.get::<_, Vec<u8>>("record_hash")),
                share: None,
            })
        })();
        let response = response.map_err(portable_publication_error)?;
        encode_json_response(&response)
    })
    .await?;

    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(response))
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
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let snapshot = subtree_snapshot(&transaction, &node_id, &user.id).await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    let response = run_publication_decode(&state, &user.id, move || {
        encode_json_response(&SharePreparationResponse {
            nodes: snapshot.into_iter().map(snapshot_response).collect(),
        })
    })
    .await?;

    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(response))
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
                  SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                         0::integer AS depth FROM files
                  WHERE id = $1 AND owner_id = $2 AND e2ee_state = 'encrypted'
                  UNION ALL
                  SELECT parent.id, parent.parent_id,
                         child.visited_ids || parent.id, child.depth + 1
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2 AND parent.e2ee_state = 'encrypted'
                    AND child.depth < 100
                    AND NOT parent.id = ANY(child.visited_ids)
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
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let principal = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    state.db.release_request_connection().await;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&principal.id).await;
    let body = parse_share_directory_publication(&state, &principal.id, &request, body).await?;
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
                  SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                         0::integer AS depth FROM files
                  WHERE id = $1 AND owner_id = $2
                  UNION ALL
                  SELECT parent.id, parent.parent_id,
                         child.visited_ids || parent.id, child.depth + 1
                  FROM files AS parent
                  INNER JOIN ancestors AS child ON child.parent_id = parent.id
                  WHERE parent.owner_id = $2
                    AND child.depth < 100
                    AND NOT parent.id = ANY(child.visited_ids)
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

    let directory_cbor = body
        .directory_cbor
        .ok_or_else(|| error::ErrorBadRequest("share directory is required"))?;
    let directory_signature = body
        .directory_signature
        .ok_or_else(|| error::ErrorBadRequest("share directory signature is required"))?;
    let validation_snapshot = ShareDirectorySnapshot {
        record_version: job.get("record_version"),
        entry_type: job.get("entry_type"),
        generation_number: job.get("current_generation_number"),
        generation_id: job.get("current_generation_id"),
        record_hash: job.get("record_hash"),
        signer_key_version: job.get("signer_key_version"),
        signer_public_key: job.get("ed25519_public_key"),
        shares: shares
            .into_iter()
            .map(|share| (share.get("id"), share.get("active_epoch")))
            .collect(),
    };
    let include_generation = validation_snapshot.entry_type == "file";
    let expected_count = validation_snapshot
        .shares
        .len()
        .checked_mul(if include_generation { 2 } else { 1 })
        .ok_or_else(|| error::ErrorBadRequest("share wrapper count is invalid"))?;
    if body.wrappers.len() != expected_count || body.wrappers.len() > 8_192 {
        return Err(error::ErrorConflict(
            "active shares changed; refresh the share directory",
        ));
    }
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    let validation_node_id = node_id.clone();
    let (validation_snapshot, directory_cbor, directory_signature, material, commitment) = state
        .vault_validation
        .run(&principal.id, move || {
            let mut expected = HashSet::with_capacity(expected_count);
            for (share_id, epoch) in &validation_snapshot.shares {
                expected.insert((share_id.clone(), *epoch, 4_u64, None));
                if include_generation {
                    expected.insert((
                        share_id.clone(),
                        *epoch,
                        3_u64,
                        Some(validation_snapshot.generation_id.clone()),
                    ));
                }
            }
            let directory = decode_share_directory(&directory_cbor)
                .map_err(|failure| (false, failure.to_string()))?;
            if directory.format_version != SHARE_DIRECTORY_VERSION
                || directory.node_id != validation_node_id
                || i64::try_from(directory.record_version).ok()
                    != Some(validation_snapshot.record_version)
                || directory.record_hash.as_slice() != validation_snapshot.record_hash
                || i64::try_from(directory.generation_number).ok()
                    != Some(validation_snapshot.generation_number)
                || directory.generation_id.as_slice() != validation_snapshot.generation_id
                || i64::try_from(directory.signer_key_version).ok()
                    != Some(validation_snapshot.signer_key_version)
            {
                return Err((
                    true,
                    "share directory targets a stale node record".to_owned(),
                ));
            }
            verify_ed25519_signature(
                &directory_cbor,
                &directory_signature,
                &validation_snapshot.signer_public_key,
            )
            .map_err(|failure| (false, failure.to_string()))?;

            let mut actual = HashSet::with_capacity(expected_count);
            let mut material = Vec::with_capacity(expected_count);
            for canonical in body.wrappers {
                let wrapper = decode_wrapper_material(canonical)
                    .map_err(|failure| (false, failure.to_string()))?;
                let record = &wrapper.record;
                if !matches!(record.kind, 3 | 4)
                    || record.node_id != validation_node_id
                    || i64::try_from(record.record_version).ok()
                        != Some(validation_snapshot.record_version)
                {
                    return Err((
                        false,
                        "share wrapper targets another node record".to_owned(),
                    ));
                }
                let share_id = record.share_id.clone().unwrap_or_default();
                let epoch = i64::try_from(record.epoch.unwrap_or_default())
                    .map_err(|_| (false, "share epoch is invalid".to_owned()))?;
                let wrapper_generation_id = record.generation_id.map(Vec::from);
                if !actual.insert((share_id, epoch, record.kind, wrapper_generation_id)) {
                    return Err((false, "share wrapper is duplicated".to_owned()));
                }
                material.push(wrapper);
            }
            if actual != expected {
                return Err((
                    true,
                    "active shares changed; refresh the share directory".to_owned(),
                ));
            }
            let hashes = material.iter().map(|value| value.hash).collect::<Vec<_>>();
            let commitment =
                wrapper_set_commitment(&hashes).map_err(|failure| (false, failure.to_string()))?;
            if directory.wrapper_set_root != commitment.root
                || i32::try_from(directory.wrapper_count).ok() != Some(commitment.count)
            {
                return Err((
                    false,
                    "share directory commitment does not match its wrappers".to_owned(),
                ));
            }
            Ok((
                validation_snapshot,
                directory_cbor,
                directory_signature,
                material,
                commitment,
            ))
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(publication_validation_error)?;
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
    let current_snapshot =
        load_share_directory_snapshot(&transaction, &node_id, &principal.id, true).await?;
    let Some(current_snapshot) = current_snapshot else {
        return Ok(HttpResponse::NoContent().finish());
    };
    if current_snapshot != validation_snapshot {
        return Err(error::ErrorConflict(
            "active shares changed; refresh the share directory",
        ));
    }
    let directory_cbor_bytes: &[u8] = directory_cbor.as_ref();
    let directory_signature_bytes: &[u8] = directory_signature.as_ref();
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
    insert_share_wrappers(
        &transaction,
        material.iter(),
        Some((&commitment, "directory")),
    )
    .await?;
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
                &validation_snapshot.record_version,
                &principal.id,
                &validation_snapshot.signer_key_version,
                &directory_cbor_bytes,
                &directory_signature_bytes,
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
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    state.db.release_request_connection().await;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let mut body = parse_create_share_publication(&state, &user.id, &request, body).await?;
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
    state.db.release_request_connection().await;
    let wrapper_input = std::mem::take(&mut body.wrappers);
    let envelope_input = std::mem::take(&mut body.envelopes);
    let validation_share_id = body.share_id.clone();
    let sender_public_key = sender_identity.ed25519_public_key.clone();
    let (wrappers, envelopes) = state
        .vault_validation
        .run(&user.id, move || {
            let wrappers = decode_share_wrappers(wrapper_input, &validation_share_id, 1)
                .map_err(|failure| failure.to_string())?;
            let envelopes = decode_share_envelopes(envelope_input, &sender_public_key)
                .map_err(|failure| failure.to_string())?;
            Ok::<_, String>((wrappers, envelopes))
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(error::ErrorBadRequest)?;
    let Some(snapshot) = read_owned_subtree_snapshot(&state, &body.root_node_id, &user.id).await?
    else {
        return Ok(HttpResponse::NotFound().body("encrypted share root not found"));
    };
    let validation_share_id = body.share_id.clone();
    let validation_sender_id = user.id.clone();
    let validation_recipient_id = body.recipient_id.clone();
    let validation_root_node_id = body.root_node_id.clone();
    let (wrappers, envelopes, wrapper_commitment, share_hash, snapshot) = state
        .vault_validation
        .run(&user.id, move || {
            let wrapper_commitment = validate_share_material(
                &wrappers,
                &envelopes,
                &snapshot,
                &validation_share_id,
                1,
                &validation_sender_id,
                sender_identity.key_version,
                &validation_recipient_id,
                recipient_key_version,
                &validation_root_node_id,
                1,
                None,
            )
            .map_err(|failure| failure.to_string())?;
            let snapshot_hash = snapshot_hash(&snapshot);
            let share_hash = share_record_hash(&snapshot_hash, &wrapper_commitment, &envelopes, 1);
            Ok::<_, String>((
                wrappers,
                envelopes,
                wrapper_commitment,
                share_hash,
                snapshot,
            ))
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(error::ErrorBadRequest)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
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
    let current_snapshot = subtree_snapshot(&transaction, &body.root_node_id, &user.id).await?;
    if current_snapshot != snapshot {
        return Err(error::ErrorConflict(
            "shared subtree changed; regenerate the share material",
        ));
    }
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
        wrappers.iter(),
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

pub async fn list_shares(
    state: web::Data<AppState>,
    request: HttpRequest,
    query: web::Query<OwnedSharesQuery>,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_configured_vault(&state, &user).await?;
    let root_node_id = query
        .root_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let cursor = decode_cursor::<OwnedSharesCursor>(query.cursor.as_deref())?;
    if cursor.as_ref().is_some_and(|cursor| {
        cursor.scope != "owned-vault-shares" || cursor.root_node_id != root_node_id
    }) {
        return Err(error::ErrorBadRequest(
            "pagination cursor does not match vault share list",
        ));
    }
    let cursor_created_at = cursor.as_ref().map(|cursor| cursor.created_at.clone());
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.clone());
    let limit = row_limit(VAULT_SHARE_PAGE_SIZE)?;
    let rows = state
        .db
        .query(
            "
                WITH share_page AS MATERIALIZED (
                  SELECT shares.id, shares.root_node_id, shares.active_epoch,
                         shares.pending_epoch, shares.status, shares.created_at,
                         shares.created_at AS cursor_created_at
                  FROM vault_shares AS shares
                  WHERE shares.owner_id = $1
                    AND shares.status IN ('active', 'rotating')
                    AND ($2::text IS NULL OR shares.root_node_id = $2)
                    AND (
                      $3::text IS NULL
                      OR shares.created_at > $3::text::timestamptz
                      OR (shares.created_at = $3::text::timestamptz AND shares.id > $4)
                    )
                  ORDER BY shares.created_at, shares.id
                  LIMIT $5
                )
                SELECT share_page.id, share_page.root_node_id,
                       share_page.active_epoch, share_page.pending_epoch,
                       share_page.status, share_page.cursor_created_at,
                       recipients.recipient_id,
                       recipients.recipient_key_version, users.username,
                       pending.recipient_id AS pending_revoked_recipient_id
                FROM share_page
                LEFT JOIN vault_share_recipients AS recipients
                  ON recipients.share_id = share_page.id AND recipients.status = 'active'
                LEFT JOIN users ON users.id = recipients.recipient_id
                LEFT JOIN vault_share_pending_revocations AS pending
                  ON pending.share_id = share_page.id
                 AND pending.pending_epoch = share_page.pending_epoch
                ORDER BY share_page.created_at, share_page.id,
                         recipients.joined_at, recipients.recipient_id
            ",
            &[
                &user.id,
                &root_node_id,
                &cursor_created_at,
                &cursor_id,
                &limit,
            ],
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
                cursor_created_at: timestamps::cursor(row.get("cursor_created_at")),
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

    let has_more = shares.len() > VAULT_SHARE_PAGE_SIZE;
    shares.truncate(VAULT_SHARE_PAGE_SIZE);
    let next_cursor = if has_more {
        shares
            .last()
            .map(|share| {
                encode_cursor(&OwnedSharesCursor {
                    scope: "owned-vault-shares".to_owned(),
                    root_node_id,
                    created_at: share.cursor_created_at.clone(),
                    id: share.share_id.clone(),
                })
            })
            .transpose()?
    } else {
        None
    };

    Ok(HttpResponse::Ok().json(OwnedSharesResponse {
        shares,
        next_cursor,
        has_more,
    }))
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
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
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
    let revoked_recipient_id: String = share.get("revoked_recipient_id");
    let current_record_version: i64 = share.get("record_version");
    let previous_record_hash = share
        .get::<_, Option<Vec<u8>>>("record_hash")
        .unwrap_or_default();
    let retained_recipients =
        load_epoch_rotation_recipients(&transaction, &share_id, &revoked_recipient_id).await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    let validation_share_id = share_id.clone();
    let plan = run_publication_decode(&state, &user.id, move || {
        let actual_snapshot_hash = snapshot_hash(&snapshot);
        if expected_snapshot_hash.as_slice() != actual_snapshot_hash {
            return Err((
                409,
                "shared subtree changed; cancel this pending rotation and start again".to_owned(),
            ));
        }
        encode_json_response(&encode_epoch_rotation_plan(
            validation_share_id,
            pending_epoch,
            actual_snapshot_hash,
            snapshot,
            retained_recipients,
            current_record_version,
            previous_record_hash,
        ))
    })
    .await?;

    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .body(plan))
}

pub async fn begin_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    let body =
        parse_json_body::<BeginEpochRotationRequest>(&request, body, VAULT_CONTROL_JSON_LIMIT)
            .await?;
    let share_id = path.into_inner();
    let (root_node_id, active_epoch, current_record_version, previous_record_hash, snapshot) = {
        let mut client = state
            .db
            .get()
            .await
            .map_err(error::ErrorInternalServerError)?;
        let transaction = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await
            .map_err(error::ErrorInternalServerError)?;
        let share = transaction
            .query_opt(
                "
                    SELECT root_node_id, active_epoch, record_version, record_hash,
                           status, publication_fenced
                    FROM vault_shares
                    WHERE id = $1 AND owner_id = $2
                ",
                &[&share_id, &user.id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        let Some(share) = share else {
            return Ok(HttpResponse::NotFound().finish());
        };
        if share.get::<_, String>("status") != "active"
            || share.get::<_, bool>("publication_fenced")
        {
            return Ok(HttpResponse::Conflict().body("share is already rotating or revoked"));
        }
        let recipient = transaction
            .query_opt(
                "SELECT 1 FROM vault_share_recipients WHERE share_id = $1 AND recipient_id = $2 AND status = 'active'",
                &[&share_id, &body.revoked_recipient_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        if recipient.is_none() {
            return Err(error::ErrorBadRequest("active share recipient not found"));
        }
        let root_node_id: String = share.get("root_node_id");
        let snapshot = subtree_snapshot(&transaction, &root_node_id, &user.id).await?;
        let values = (
            root_node_id,
            share.get::<_, i64>("active_epoch"),
            share.get::<_, i64>("record_version"),
            share
                .get::<_, Option<Vec<u8>>>("record_hash")
                .unwrap_or_default(),
            snapshot,
        );
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        drop(client);
        values
    };
    let (snapshot, fence_snapshot_hash) = state
        .vault_validation
        .run(&user.id, move || {
            let fence_snapshot_hash = snapshot_hash(&snapshot);
            (snapshot, fence_snapshot_hash)
        })
        .await
        .map_err(vault_validation_error)?;

    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
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
    if share.get::<_, String>("status") != "active"
        || share.get::<_, bool>("publication_fenced")
        || share.get::<_, String>("root_node_id") != root_node_id
        || share.get::<_, i64>("active_epoch") != active_epoch
        || share.get::<_, i64>("record_version") != current_record_version
        || share
            .get::<_, Option<Vec<u8>>>("record_hash")
            .unwrap_or_default()
            != previous_record_hash
    {
        return Ok(HttpResponse::Conflict().body("share changed; retry the rotation"));
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
    let current_snapshot = subtree_snapshot(&transaction, &root_node_id, &user.id).await?;
    if current_snapshot != snapshot {
        return Err(error::ErrorConflict(
            "shared subtree changed; retry the rotation",
        ));
    }
    let pending_epoch = active_epoch
        .checked_add(1)
        .ok_or_else(|| error::ErrorInternalServerError("share epoch exhausted"))?;
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
    transaction
        .execute(
            "UPDATE vault_shares SET fence_snapshot_hash = $1 WHERE id = $2",
            &[&fence_snapshot_hash.as_slice(), &share_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let retained_recipients =
        load_epoch_rotation_recipients(&transaction, &share_id, &body.revoked_recipient_id).await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    let validation_share_id = share_id.clone();
    let plan = run_publication_decode(&state, &user.id, move || {
        encode_json_response(&encode_epoch_rotation_plan(
            validation_share_id,
            pending_epoch,
            fence_snapshot_hash,
            snapshot,
            retained_recipients,
            current_record_version,
            previous_record_hash,
        ))
    })
    .await?;

    Ok(HttpResponse::Created()
        .content_type("application/json")
        .body(plan))
}

async fn load_epoch_rotation_recipients(
    transaction: &tokio_postgres::Transaction<'_>,
    share_id: &str,
    revoked_recipient_id: &str,
) -> Result<Vec<EpochRecipientMaterial>> {
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
    Ok(recipient_rows
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("recipient_id"),
                row.get::<_, i64>("recipient_key_version"),
                row.get::<_, Vec<u8>>("x25519_public_key"),
                row.get::<_, Vec<u8>>("ed25519_public_key"),
                row.get::<_, Vec<u8>>("fingerprint_sha256"),
            )
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn encode_epoch_rotation_plan(
    share_id: String,
    pending_epoch: i64,
    fence_snapshot_hash: [u8; 32],
    snapshot: Vec<SnapshotNode>,
    retained_recipients: Vec<EpochRecipientMaterial>,
    current_record_version: i64,
    previous_record_hash: Vec<u8>,
) -> EpochRotationPlanResponse {
    EpochRotationPlanResponse {
        share_id,
        pending_epoch,
        fence_snapshot_hash: encode_bytes(fence_snapshot_hash),
        nodes: snapshot.into_iter().map(snapshot_response).collect(),
        retained_recipients: retained_recipients
            .into_iter()
            .map(
                |(
                    user_id,
                    key_version,
                    x25519_public_key,
                    ed25519_public_key,
                    fingerprint_sha256,
                )| EpochRecipient {
                    user_id,
                    key_version,
                    x25519_public_key: encode_bytes(x25519_public_key),
                    ed25519_public_key: encode_bytes(ed25519_public_key),
                    fingerprint_sha256: encode_bytes(fingerprint_sha256),
                },
            )
            .collect(),
        record_version: current_record_version + 1,
        previous_record_hash: encode_bytes(previous_record_hash),
    }
}

pub async fn publish_epoch_rotation(
    state: web::Data<AppState>,
    request: HttpRequest,
    path: web::Path<(String, i64)>,
    body: web::Payload,
) -> Result<HttpResponse> {
    require_vault_enabled(&state)?;
    let user = require_principal(&state, &request).await?;
    require_header_csrf(&state, &request).await?;
    state.db.release_request_connection().await;
    let _mutation_permit = state.vault_mutation_limiter.acquire(&user.id).await;
    let mut body = parse_publish_epoch_publication(&state, &user.id, &request, body).await?;
    let (share_id, pending_epoch) = path.into_inner();
    let requested_snapshot_hash: [u8; 32] = body
        .fence_snapshot_hash
        .as_ref()
        .try_into()
        .map_err(|_| error::ErrorBadRequest("fence snapshot hash has an invalid length"))?;
    let owner_epoch_key = validate_owner_epoch_key(&body.owner_epoch_key)?;
    let sender_identity = active_identity(&state, &user.id).await?;
    state.db.release_request_connection().await;
    let wrapper_input = std::mem::take(&mut body.wrappers);
    let envelope_input = std::mem::take(&mut body.envelopes);
    let validation_share_id = share_id.clone();
    let sender_public_key = sender_identity.ed25519_public_key.clone();
    let (wrappers, envelopes) = state
        .vault_validation
        .run(&user.id, move || {
            let wrappers =
                decode_share_wrappers(wrapper_input, &validation_share_id, pending_epoch)
                    .map_err(|failure| failure.to_string())?;
            let envelopes = decode_share_envelopes(envelope_input, &sender_public_key)
                .map_err(|failure| failure.to_string())?;
            Ok::<_, String>((wrappers, envelopes))
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(error::ErrorBadRequest)?;
    let publication_snapshot = {
        let mut client = state
            .db
            .get()
            .await
            .map_err(error::ErrorInternalServerError)?;
        let transaction = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await
            .map_err(error::ErrorInternalServerError)?;
        let snapshot =
            load_epoch_publication_snapshot(&transaction, &share_id, &user.id, false).await?;
        transaction
            .commit()
            .await
            .map_err(error::ErrorInternalServerError)?;
        drop(client);
        snapshot
    };
    let Some(publication_snapshot) = publication_snapshot else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if publication_snapshot.pending_epoch != Some(pending_epoch)
        || !publication_snapshot.publication_fenced
        || publication_snapshot.fence_snapshot_hash.as_deref()
            != Some(requested_snapshot_hash.as_slice())
    {
        return Err(error::ErrorConflict("share rotation fence changed"));
    }
    let next_record_version = publication_snapshot
        .record_version
        .checked_add(1)
        .ok_or_else(|| error::ErrorInternalServerError("share record version exhausted"))?;
    let validation_share_id = share_id.clone();
    let validation_sender_id = user.id.clone();
    let (wrappers, envelopes, wrapper_commitment, cutoff_hash, publication_snapshot) = state
        .vault_validation
        .run(&user.id, move || {
            let current_snapshot_hash = snapshot_hash(&publication_snapshot.nodes);
            if current_snapshot_hash != requested_snapshot_hash {
                return Err(
                    "shared subtree changed; discard this epoch material and regenerate it"
                        .to_owned(),
                );
            }
            let wrapper_commitment = validate_rotation_material(
                &wrappers,
                &envelopes,
                &publication_snapshot.nodes,
                &validation_share_id,
                pending_epoch,
                &validation_sender_id,
                sender_identity.key_version,
                &publication_snapshot.retained_recipients,
                &publication_snapshot.root_node_id,
                next_record_version,
                publication_snapshot.record_hash.as_deref(),
            )
            .map_err(|failure| failure.to_string())?;
            let cutoff_hash = share_record_hash(
                &requested_snapshot_hash,
                &wrapper_commitment,
                &envelopes,
                pending_epoch,
            );
            Ok::<_, String>((
                wrappers,
                envelopes,
                wrapper_commitment,
                cutoff_hash,
                publication_snapshot,
            ))
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(error::ErrorBadRequest)?;
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    lock_share_topology(&transaction, &user.id).await?;
    let current_snapshot =
        load_epoch_publication_snapshot(&transaction, &share_id, &user.id, true).await?;
    let Some(current_snapshot) = current_snapshot else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if current_snapshot != publication_snapshot {
        return Err(error::ErrorConflict(
            "share rotation state changed; regenerate the epoch material",
        ));
    }
    let root_node_id = publication_snapshot.root_node_id;
    let revoked = publication_snapshot.revoked_recipient_id;
    let active_epoch = publication_snapshot.active_epoch;
    insert_owner_epoch_key(&transaction, &share_id, pending_epoch, &owner_epoch_key).await?;
    insert_share_wrappers(
        &transaction,
        wrappers.iter(),
        Some((&wrapper_commitment, "epoch")),
    )
    .await?;
    insert_share_envelopes(&transaction, &envelopes).await?;
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

fn validate_owner_epoch_key(request: &OwnerEpochKey) -> Result<OwnerEpochKeyMaterial> {
    Ok(OwnerEpochKeyMaterial {
        wrapper_id: request
            .wrapper_id
            .as_ref()
            .try_into()
            .map_err(|_| error::ErrorBadRequest("owner epoch wrapper id has an invalid length"))?,
        ciphertext: request
            .ciphertext
            .as_ref()
            .try_into()
            .map_err(|_| error::ErrorBadRequest("owner epoch ciphertext has an invalid length"))?,
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
    encoded: Vec<Bytes>,
    share_id: &str,
    epoch: i64,
) -> Result<Vec<ShareWrapperMaterial>> {
    if encoded.is_empty() || encoded.len() > 8_192 || epoch <= 0 {
        return Err(error::ErrorBadRequest("share wrapper count is invalid"));
    }
    let mut ids = HashSet::new();
    encoded
        .into_iter()
        .map(|canonical| {
            let material = decode_wrapper_material(canonical).map_err(error::ErrorBadRequest)?;
            let record = &material.record;
            if !matches!(record.kind, 3 | 4)
                || record.share_id.as_deref() != Some(share_id)
                || i64::try_from(record.epoch.unwrap_or_default()).ok() != Some(epoch)
                || !ids.insert(record.wrapper_id)
            {
                return Err(error::ErrorBadRequest("share wrapper scope is invalid"));
            }
            Ok(material)
        })
        .collect()
}

fn decode_share_envelopes(
    encoded: Vec<SignedEnvelope>,
    sender_ed25519_public_key: &[u8],
) -> Result<Vec<ShareEnvelopeMaterial>> {
    if encoded.len() > 1_024 {
        return Err(error::ErrorBadRequest("share envelope count is invalid"));
    }
    let mut ids = HashSet::new();
    encoded
        .into_iter()
        .map(|value| {
            let canonical = value.canonical_cbor;
            let signature = value.signature;
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

async fn read_owned_subtree_snapshot(
    state: &AppState,
    root_node_id: &str,
    owner_id: &str,
) -> Result<Option<Vec<SnapshotNode>>> {
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let root_exists = transaction
        .query_opt(
            "SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND e2ee_state = 'encrypted' AND state = 'active'",
            &[&root_node_id, &owner_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .is_some();
    let snapshot = if root_exists {
        Some(subtree_snapshot(&transaction, root_node_id, owner_id).await?)
    } else {
        None
    };
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    Ok(snapshot)
}

async fn load_epoch_publication_snapshot(
    transaction: &deadpool_postgres::Transaction<'_>,
    share_id: &str,
    owner_id: &str,
    lock: bool,
) -> Result<Option<EpochPublicationSnapshot>> {
    let share_query = if lock {
        "
            SELECT root_node_id, active_epoch, pending_epoch,
                   publication_fenced, fence_snapshot_hash,
                   record_version, record_hash
            FROM vault_shares
            WHERE id = $1 AND owner_id = $2 AND status = 'rotating'
            FOR UPDATE
        "
    } else {
        "
            SELECT root_node_id, active_epoch, pending_epoch,
                   publication_fenced, fence_snapshot_hash,
                   record_version, record_hash
            FROM vault_shares
            WHERE id = $1 AND owner_id = $2 AND status = 'rotating'
        "
    };
    let Some(share) = transaction
        .query_opt(share_query, &[&share_id, &owner_id])
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(None);
    };
    let root_node_id: String = share.get("root_node_id");
    let pending_epoch: Option<i64> = share.get("pending_epoch");
    let revoked_recipient_id = transaction
        .query_opt(
            "SELECT recipient_id FROM vault_share_pending_revocations WHERE share_id = $1 AND pending_epoch = $2",
            &[&share_id, &pending_epoch],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .ok_or_else(|| error::ErrorConflict("pending share revocation changed"))?
        .get::<_, String>("recipient_id");
    let retained_recipients = transaction
        .query(
            "
                SELECT recipient_id, recipient_key_version
                FROM vault_share_recipients
                WHERE share_id = $1 AND status = 'active' AND recipient_id <> $2
                ORDER BY recipient_id
            ",
            &[&share_id, &revoked_recipient_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("recipient_id"),
                row.get::<_, i64>("recipient_key_version"),
            )
        })
        .collect();
    let nodes = subtree_snapshot(transaction, &root_node_id, owner_id).await?;
    Ok(Some(EpochPublicationSnapshot {
        root_node_id,
        active_epoch: share.get("active_epoch"),
        pending_epoch,
        publication_fenced: share.get("publication_fenced"),
        fence_snapshot_hash: share.get("fence_snapshot_hash"),
        record_version: share.get("record_version"),
        record_hash: share.get("record_hash"),
        revoked_recipient_id,
        retained_recipients,
        nodes,
    }))
}

async fn load_share_directory_snapshot(
    transaction: &deadpool_postgres::Transaction<'_>,
    node_id: &str,
    owner_id: &str,
    lock: bool,
) -> Result<Option<ShareDirectorySnapshot>> {
    let job_query = if lock {
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
        "
    } else {
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
        "
    };
    let Some(job) = transaction
        .query_opt(job_query, &[&node_id, &owner_id])
        .await
        .map_err(error::ErrorInternalServerError)?
    else {
        return Ok(None);
    };
    let share_query = if lock {
        "
            WITH RECURSIVE ancestors AS (
              SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                     0::integer AS depth FROM files
              WHERE id = $1 AND owner_id = $2
              UNION ALL
              SELECT parent.id, parent.parent_id,
                     child.visited_ids || parent.id, child.depth + 1
              FROM files AS parent
              INNER JOIN ancestors AS child ON child.parent_id = parent.id
              WHERE parent.owner_id = $2
                AND child.depth < 100
                AND NOT parent.id = ANY(child.visited_ids)
            )
            SELECT shares.id, shares.active_epoch
            FROM vault_shares AS shares
            INNER JOIN ancestors ON ancestors.id = shares.root_node_id
            WHERE shares.owner_id = $2 AND shares.status = 'active'
              AND shares.publication_fenced = FALSE
            ORDER BY shares.id
            FOR SHARE OF shares
        "
    } else {
        "
            WITH RECURSIVE ancestors AS (
              SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                     0::integer AS depth FROM files
              WHERE id = $1 AND owner_id = $2
              UNION ALL
              SELECT parent.id, parent.parent_id,
                     child.visited_ids || parent.id, child.depth + 1
              FROM files AS parent
              INNER JOIN ancestors AS child ON child.parent_id = parent.id
              WHERE parent.owner_id = $2
                AND child.depth < 100
                AND NOT parent.id = ANY(child.visited_ids)
            )
            SELECT shares.id, shares.active_epoch
            FROM vault_shares AS shares
            INNER JOIN ancestors ON ancestors.id = shares.root_node_id
            WHERE shares.owner_id = $2 AND shares.status = 'active'
              AND shares.publication_fenced = FALSE
            ORDER BY shares.id
        "
    };
    let shares = transaction
        .query(share_query, &[&node_id, &owner_id])
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("id"),
                row.get::<_, i64>("active_epoch"),
            )
        })
        .collect();
    Ok(Some(ShareDirectorySnapshot {
        record_version: job.get("record_version"),
        entry_type: job.get("entry_type"),
        generation_number: job.get("current_generation_number"),
        generation_id: job.get("current_generation_id"),
        record_hash: job.get("record_hash"),
        signer_key_version: job.get("signer_key_version"),
        signer_public_key: job.get("ed25519_public_key"),
        shares,
    }))
}

async fn subtree_snapshot(
    transaction: &deadpool_postgres::Transaction<'_>,
    root_node_id: &str,
    owner_id: &str,
) -> Result<Vec<SnapshotNode>> {
    let Some(tree) = walk_subtree(
        transaction,
        TreeWalkScope {
            owner_id,
            root_id: root_node_id,
            root_state: Some("active"),
            child_state: Some("active"),
            e2ee_state: Some("encrypted"),
            max_nodes: MAX_TREE_MUTATION_NODES,
        },
    )
    .await
    .map_err(error::ErrorInternalServerError)?
    else {
        return Err(error::ErrorConflict(
            "shared subtree is empty or incomplete",
        ));
    };
    if tree.truncated {
        return Err(error::ErrorPayloadTooLarge(
            "shared subtree contains too many nodes",
        ));
    }
    let node_ids = tree
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    let mut snapshot = Vec::with_capacity(node_ids.len());
    for ids in node_ids.chunks(TREE_MUTATION_BATCH_SIZE) {
        let rows = transaction
            .query(
                "
                    SELECT files.id, files.entry_type,
                           files.current_generation_number,
                           files.current_generation_id,
                           heads.record_version, heads.record_hash
                    FROM unnest($1::text[]) WITH ORDINALITY AS requested(id, ordinal)
                    INNER JOIN files ON files.id = requested.id
                    INNER JOIN vault_node_heads AS heads ON heads.node_id = files.id
                    WHERE files.owner_id = $2
                      AND files.state = 'active'
                      AND files.e2ee_state = 'encrypted'
                    ORDER BY requested.ordinal
                ",
                &[&ids, &owner_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?;
        snapshot.extend(rows.into_iter().map(|row| SnapshotNode {
            node_id: row.get("id"),
            entry_type: row.get("entry_type"),
            generation_number: row.get("current_generation_number"),
            generation_id: row.get("current_generation_id"),
            record_version: row.get("record_version"),
            record_hash: row.get("record_hash"),
        }));
    }
    if snapshot.len() != node_ids.len() {
        return Err(error::ErrorConflict(
            "shared subtree is empty or incomplete",
        ));
    }
    Ok(snapshot)
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

async fn committed_share_wrappers<'a>(
    transaction: &tokio_postgres::Transaction<'_>,
    decoded: &'a DecodedNodeRecord,
    node_id: &str,
    parent_id: Option<&str>,
    owner_id: &str,
    include_generation: bool,
) -> Result<Vec<&'a ShareWrapperMaterial>> {
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
                      SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                             0::integer AS depth FROM files
                      WHERE id = $1 AND owner_id = $2
                      UNION ALL
                      SELECT parent.id, parent.parent_id,
                             child.visited_ids || parent.id, child.depth + 1
                      FROM files AS parent
                      INNER JOIN ancestors AS child ON child.parent_id = parent.id
                      WHERE parent.owner_id = $2
                        AND child.depth < 100
                        AND NOT parent.id = ANY(child.visited_ids)
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
    for wrapper in &decoded.wrappers {
        let record = &wrapper.record;
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
        material.push(wrapper);
    }
    if actual != expected {
        return Err(error::ErrorConflict(
            "active shares changed; regenerate the node record with current share-epoch wrappers",
        ));
    }
    Ok(material)
}

async fn publication_share_wrappers<'a>(
    transaction: &tokio_postgres::Transaction<'_>,
    decoded: &'a DecodedNodeRecord,
    node_id: &str,
    parent_id: Option<&str>,
    owner_id: &str,
    include_generation: bool,
) -> Result<(Vec<&'a ShareWrapperMaterial>, bool)> {
    let has_inline_share_wrappers = decoded
        .wrappers
        .iter()
        .any(|wrapper| matches!(wrapper.record.kind, 3 | 4));
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
                    SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                           0::integer AS depth FROM files
                    WHERE id = $1 AND owner_id = $2
                    UNION ALL
                    SELECT parent.id, parent.parent_id,
                           child.visited_ids || parent.id, child.depth + 1
                    FROM files AS parent
                    INNER JOIN ancestors AS child ON child.parent_id = parent.id
                    WHERE parent.owner_id = $2
                      AND child.depth < 100
                      AND NOT parent.id = ANY(child.visited_ids)
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

async fn insert_share_wrappers<'a>(
    transaction: &tokio_postgres::Transaction<'_>,
    wrappers: impl IntoIterator<Item = &'a ShareWrapperMaterial>,
    commitment: Option<(&WrapperSetCommitment, &'static str)>,
) -> Result<()> {
    let wrappers = wrappers.into_iter().collect::<Vec<_>>();
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
        canonical_records.push(wrapper.canonical.to_vec());
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
        canonical_records.push(envelope.canonical.to_vec());
        signatures.push(envelope.signature.to_vec());
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
    let mut completed_metadata = None;
    if upload.mode == "multipart" {
        let multipart_id = upload
            .multipart_upload_id
            .as_deref()
            .ok_or_else(|| error::ErrorInternalServerError("multipart upload id is missing"))?;
        match state
            .storage
            .complete_multipart(
                object_key,
                multipart_id,
                parts,
                u64::try_from(upload.ciphertext_length)
                    .map_err(|_| error::ErrorInternalServerError("invalid ciphertext length"))?,
            )
            .await
        {
            Ok(metadata) => completed_metadata = Some(metadata),
            Err(complete_error) => match state.storage.object_metadata(object_key).await {
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
            },
        }
    }
    let metadata = match completed_metadata {
        Some(metadata) => metadata,
        None => state
            .storage
            .object_metadata(object_key)
            .await
            .map_err(error::ErrorBadGateway)?,
    };
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
    insert_share_wrappers(&transaction, committed_share_wrappers.iter().copied(), None).await?;
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
    body: NodePublication,
) -> Result<DecodedNodeRecord> {
    let identities = state
        .db
        .query(
            "
                SELECT key_version, ed25519_public_key
                FROM vault_identity_keys
                WHERE user_id = $1 AND status = 'active'
            ",
            &[&user.id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| {
            (
                row.get::<_, i64>("key_version"),
                row.get::<_, Vec<u8>>("ed25519_public_key"),
            )
        })
        .collect::<Vec<_>>();
    state.db.release_request_connection().await;
    state
        .vault_validation
        .run(&user.id, move || {
            validate_node_publication_material(body, identities)
        })
        .await
        .map_err(vault_validation_error)?
        .map_err(|(forbidden, message)| {
            if forbidden {
                error::ErrorForbidden(message)
            } else {
                error::ErrorBadRequest(message)
            }
        })
}

fn validate_node_publication_material(
    body: NodePublication,
    identities: Vec<(i64, Vec<u8>)>,
) -> std::result::Result<DecodedNodeRecord, (bool, String)> {
    let NodePublication {
        parts: _,
        bootstrap_cbor,
        bootstrap_signature: signature,
        encrypted_manifest,
        wrappers,
    } = body;
    if wrappers.is_empty() || wrappers.len() > 4_096 {
        return Err((false, "wrapper count is invalid".to_owned()));
    }
    let bootstrap =
        decode_bootstrap(&bootstrap_cbor).map_err(|failure| (false, failure.to_string()))?;
    let signer_key_version = i64::try_from(bootstrap.signer_key_version)
        .map_err(|_| (false, "signer key version is invalid".to_owned()))?;
    let public_key = identities
        .iter()
        .find(|(key_version, _)| *key_version == signer_key_version)
        .map(|(_, public_key)| public_key)
        .ok_or_else(|| (true, "signing identity is not active".to_owned()))?;
    let wrappers = wrappers
        .into_iter()
        .map(decode_wrapper_material)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|failure| (false, failure.to_string()))?;
    let verified = verify_decoded_node_record(
        &bootstrap_cbor,
        bootstrap,
        &signature,
        &encrypted_manifest,
        &wrappers,
        public_key,
    )
    .map_err(|failure| (false, failure.to_string()))?;
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
        .map(|wrapper| &wrapper.record)
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
    upload_mode: String,
    ciphertext_length: i64,
    requested: Vec<vault_wire::CompletedPart>,
) -> Result<Vec<UploadedPart>> {
    if upload_mode != "multipart" {
        if requested.is_empty() {
            return Ok(Vec::new());
        }
        return Err(error::ErrorBadRequest("multipart parts are not expected"));
    }
    let ciphertext_length = u64::try_from(ciphertext_length)
        .map_err(|_| error::ErrorInternalServerError("ciphertext length is invalid"))?;
    let expected_count = ciphertext_length.div_ceil(UPLOAD_PART_BYTES);
    if requested.is_empty()
        || requested.len() > 10_000
        || u64::try_from(requested.len()).ok() != Some(expected_count)
    {
        return Err(error::ErrorBadRequest("multipart parts are invalid"));
    }
    let mut parts = requested
        .into_iter()
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
    let bootstrap_cbor: &[u8] = decoded.bootstrap_cbor.as_ref();
    let signature: &[u8] = decoded.signature.as_ref();
    let encrypted_manifest: &[u8] = decoded.encrypted_manifest.as_ref();
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
                &bootstrap_cbor,
                &signature,
                &encrypted_manifest,
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
    for material in &decoded.wrappers {
        let wrapper = &material.record;
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
        let canonical: &[u8] = material.canonical.as_ref();
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
                    &material.hash.as_slice(),
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
                    SELECT id, parent_id, ARRAY[id]::text[] AS visited_ids,
                           0::integer AS depth FROM files
                    WHERE id = $1 AND owner_id = $2
                    UNION ALL
                    SELECT parent.id, parent.parent_id,
                           child.visited_ids || parent.id, child.depth + 1
                    FROM files AS parent
                    INNER JOIN ancestors AS child ON child.parent_id = parent.id
                    WHERE parent.owner_id = $2
                      AND child.depth < 100
                      AND NOT parent.id = ANY(child.visited_ids)
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

async fn load_shared_plan(
    state: &AppState,
    user: &SessionPrincipal,
    node_id: &str,
    include_download_url: bool,
    encode_response: bool,
) -> Result<SharedDownloadCpuResponse> {
    let mut client = state
        .db
        .get()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let transaction = client
        .transaction()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let row = transaction
        .query_opt(SHARED_DOWNLOAD_SNAPSHOT_QUERY, &[&node_id, &user.id])
        .await
        .map_err(error::ErrorInternalServerError)?;
    // The row owns the complete consistent snapshot. Release all share,
    // recipient, and epoch locks before decoding, hashing, base64 work, or S3
    // URL signing; those steps cannot extend revocation safety after response.
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Ok(SharedDownloadCpuResponse::NotFound);
    };
    let object_key: Option<String> = row.get("object_key");
    drop(client);
    let download_url = if include_download_url {
        if let Some(object_key) = object_key.as_deref() {
            state
                .storage
                .download_url(object_key, "aeralyth-ciphertext.bin")
                .await
                .map_err(error::ErrorBadGateway)?
        } else {
            None
        }
    } else {
        None
    };
    let user_id = user.id.clone();
    let node_id = node_id.to_owned();
    let response = run_publication_decode(state, &user.id, move || {
        let prepared: Result<Option<DownloadPlanResponse>> = (|| {
            let SharedDownloadSnapshot {
                share_id,
                owner_id,
                root_node_id,
                active_epoch,
                share_record_version,
                share_previous_record_hash,
                recipient_key_version,
                epoch_protocol_version,
                epoch_wrapper_set_root,
                epoch_wrapper_count,
                entry_type,
                current_generation_number,
                current_generation_id: generation_id,
                bootstrap_cbor,
                bootstrap_signature,
                encrypted_manifest,
                signer_key_version,
                node_record_version,
                record_hash,
                node_signer_ed25519_public_key,
                ciphertext_length,
                crypto_chunk_bytes,
                chunk_count,
                ciphertext_merkle_root,
                wrappers: wrapper_snapshots,
                envelope,
                directory: directory_snapshot,
            } = shared_download_snapshot_from_row(row)?;

            let expected_wrapper_count = if entry_type == "file" { 2 } else { 1 };
            if wrapper_snapshots.len() != expected_wrapper_count {
                return Ok(None);
            }
            let decoded_envelope = decode_share_envelope(&envelope.canonical_cbor)
                .map_err(error::ErrorInternalServerError)?;
            if envelope.sender_id != owner_id
                || envelope.recipient_id != user_id
                || envelope.node_id != root_node_id
                || envelope.record_version != share_record_version
                || envelope.previous_record_hash != share_previous_record_hash
                || envelope.recipient_key_version != recipient_key_version
                || i16::try_from(decoded_envelope.format_version).ok()
                    != Some(epoch_protocol_version)
                || (epoch_protocol_version == SHARE_ENVELOPE_VERSION as i16
                    && (decoded_envelope
                        .wrapper_set_root
                        .as_ref()
                        .map(|value| value.as_slice())
                        != epoch_wrapper_set_root.as_deref()
                        || i32::try_from(decoded_envelope.wrapper_count).ok()
                            != epoch_wrapper_count))
            {
                return Err(error::ErrorInternalServerError(
                    "published share envelope is inconsistent with its active epoch",
                ));
            }
            let commitment_sources = wrapper_snapshots
                .iter()
                .map(|wrapper| wrapper.commitment_source.as_str())
                .collect::<HashSet<_>>();
            if commitment_sources.len() != 1 {
                return Err(error::ErrorInternalServerError(
                    "share wrappers use inconsistent commitments",
                ));
            }
            let uses_directory = commitment_sources.contains("directory");
            if uses_directory && directory_snapshot.is_none() {
                return Err(error::ErrorInternalServerError(
                    "share-wrapper directory is missing",
                ));
            }
            let bootstrap =
                decode_bootstrap(&bootstrap_cbor).map_err(error::ErrorInternalServerError)?;
            let epoch_root = epoch_wrapper_set_root
                .as_deref()
                .map(<[u8; 32]>::try_from)
                .transpose()
                .map_err(|_| error::ErrorInternalServerError("stored wrapper root is invalid"))?;
            let directory_material = directory_snapshot
                .map(|directory| -> Result<_> {
                    let root = <[u8; 32]>::try_from(directory.wrapper_set_root.as_slice())
                        .map_err(|_| {
                            error::ErrorInternalServerError("stored directory root is invalid")
                        })?;
                    let decoded = decode_share_directory(&directory.canonical_cbor)
                        .map_err(error::ErrorInternalServerError)?;
                    if decoded.node_id != node_id
                        || i64::try_from(decoded.record_version).ok() != Some(node_record_version)
                        || decoded.record_hash.as_slice() != record_hash
                        || decoded.generation_id.as_slice() != generation_id
                        || i64::try_from(decoded.generation_number).ok()
                            != Some(current_generation_number)
                        || i64::try_from(decoded.signer_key_version).ok()
                            != Some(directory.signer_key_version)
                        || decoded.wrapper_set_root != root
                        || i32::try_from(decoded.wrapper_count).ok()
                            != Some(directory.wrapper_count)
                    {
                        return Err(error::ErrorInternalServerError(
                            "stored share-wrapper directory is inconsistent",
                        ));
                    }
                    verify_ed25519_signature(
                        &directory.canonical_cbor,
                        &directory.signature,
                        &node_signer_ed25519_public_key,
                    )
                    .map_err(error::ErrorInternalServerError)?;
                    Ok((
                        directory.canonical_cbor,
                        directory.signature,
                        root,
                        directory.wrapper_count,
                    ))
                })
                .transpose()?;
            let mut wrappers = Vec::with_capacity(wrapper_snapshots.len());
            let mut wrapper_proofs = Vec::with_capacity(wrapper_snapshots.len());
            let mut directory_proofs = Vec::with_capacity(wrapper_snapshots.len());
            for wrapper in wrapper_snapshots {
                let canonical = wrapper.canonical_cbor;
                let wrapper_hash = sha256(&canonical);
                wrappers.push(encode_bytes(canonical));
                let leaf_index = wrapper.merkle_leaf_index;
                let proof = wrapper.merkle_proof;
                let commitment_source = wrapper.commitment_source;
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
            let directory = directory_material.map(|(canonical_cbor, signature, _, _)| {
                ShareDirectoryResponse {
                    canonical_cbor: encode_bytes(canonical_cbor),
                    signature: encode_bytes(signature),
                    wrapper_proofs: directory_proofs,
                }
            });
            let response = DownloadPlanResponse {
                node_id: node_id.to_owned(),
                entry_type,
                generation_number: current_generation_number,
                generation_id: encode_bytes(generation_id),
                ciphertext_length: ciphertext_length.unwrap_or(0),
                crypto_chunk_bytes: crypto_chunk_bytes.unwrap_or(CRYPTO_CHUNK_BYTES as i32),
                chunk_count: chunk_count.unwrap_or(0),
                ciphertext_merkle_root: encode_bytes(
                    ciphertext_merkle_root
                        .unwrap_or_else(|| bootstrap.ciphertext_merkle_root.to_vec()),
                ),
                download_url,
                bootstrap_cbor: encode_bytes(bootstrap_cbor),
                bootstrap_signature: encode_bytes(bootstrap_signature),
                encrypted_manifest: encode_bytes(encrypted_manifest),
                wrappers,
                signer_key_version,
                signer_ed25519_public_key: encode_bytes(node_signer_ed25519_public_key),
                record_version: node_record_version,
                record_hash: encode_bytes(record_hash),
                share: Some(ShareDownloadMaterial {
                    share_id,
                    epoch: active_epoch,
                    root_node_id,
                    sender_id: owner_id,
                    recipient_id: user_id,
                    record_version: share_record_version,
                    previous_record_hash: share_previous_record_hash.map(encode_bytes),
                    envelope_cbor: encode_bytes(envelope.canonical_cbor),
                    envelope_signature: encode_bytes(envelope.signature),
                    envelope_hash: encode_bytes(envelope.envelope_hash),
                    sender_key_version: envelope.sender_key_version,
                    sender_x25519_public_key: encode_bytes(envelope.sender_x25519_public_key),
                    sender_ed25519_public_key: encode_bytes(envelope.sender_ed25519_public_key),
                    sender_fingerprint_sha256: encode_bytes(envelope.sender_fingerprint_sha256),
                    recipient_key_version,
                    wrapper_proofs,
                    directory,
                }),
            };

            Ok(Some(response))
        })();
        match prepared.map_err(portable_publication_error)? {
            Some(response) if encode_response => {
                encode_json_response(&response).map(SharedDownloadCpuResponse::Json)
            }
            Some(response) => Ok(SharedDownloadCpuResponse::Plan(response)),
            None => Ok(SharedDownloadCpuResponse::Conflict),
        }
    })
    .await?;
    Ok(response)
}

enum SharedDownloadCpuResponse {
    Plan(DownloadPlanResponse),
    Json(Bytes),
    Conflict,
    NotFound,
}

async fn shared_download_plan(
    state: &AppState,
    user: &SessionPrincipal,
    node_id: &str,
) -> Result<HttpResponse> {
    match load_shared_plan(state, user, node_id, true, true).await? {
        SharedDownloadCpuResponse::Json(body) => Ok(HttpResponse::Ok()
            .content_type("application/json")
            .body(body)),
        SharedDownloadCpuResponse::Conflict => {
            Ok(HttpResponse::Conflict().body("share material is still synchronizing"))
        }
        SharedDownloadCpuResponse::NotFound => Ok(HttpResponse::NotFound().finish()),
        SharedDownloadCpuResponse::Plan(_) => Err(error::ErrorInternalServerError(
            "shared download plan response was not encoded",
        )),
    }
}

async fn load_shared_metadata_plan(
    state: &AppState,
    user: &SessionPrincipal,
    node_id: &str,
) -> Result<Option<MetadataPlanResponse>> {
    match load_shared_plan(state, user, node_id, false, false).await? {
        SharedDownloadCpuResponse::Plan(plan) => Ok(Some(plan.into())),
        SharedDownloadCpuResponse::Conflict | SharedDownloadCpuResponse::NotFound => Ok(None),
        SharedDownloadCpuResponse::Json(_) => Err(error::ErrorInternalServerError(
            "shared metadata plan was unexpectedly encoded",
        )),
    }
}

fn shared_download_snapshot_from_row(row: tokio_postgres::Row) -> Result<SharedDownloadSnapshot> {
    let wrapper_cbors: Vec<Vec<u8>> = row.get("wrapper_cbors");
    let wrapper_leaf_indexes: Vec<Option<i32>> = row.get("wrapper_leaf_indexes");
    let wrapper_merkle_proofs: Vec<Option<Vec<u8>>> = row.get("wrapper_merkle_proofs");
    let wrapper_commitment_sources: Vec<String> = row.get("wrapper_commitment_sources");
    let wrapper_count = wrapper_cbors.len();
    if wrapper_leaf_indexes.len() != wrapper_count
        || wrapper_merkle_proofs.len() != wrapper_count
        || wrapper_commitment_sources.len() != wrapper_count
    {
        return Err(error::ErrorInternalServerError(
            "shared download wrapper snapshot is misaligned",
        ));
    }
    let wrappers = wrapper_cbors
        .into_iter()
        .zip(wrapper_leaf_indexes)
        .zip(wrapper_merkle_proofs)
        .zip(wrapper_commitment_sources)
        .map(
            |(((canonical_cbor, merkle_leaf_index), merkle_proof), commitment_source)| {
                SharedWrapperSnapshot {
                    canonical_cbor,
                    merkle_leaf_index,
                    merkle_proof,
                    commitment_source,
                }
            },
        )
        .collect();

    let envelope_cbor: Option<Vec<u8>> = row.get("envelope_cbor");
    let Some(envelope_cbor) = envelope_cbor else {
        return Err(error::ErrorInternalServerError(
            "published share envelope is missing",
        ));
    };
    let envelope = SharedEnvelopeSnapshot {
        canonical_cbor: envelope_cbor,
        signature: required_snapshot_column(&row, "envelope_signature")?,
        envelope_hash: required_snapshot_column(&row, "envelope_hash")?,
        sender_key_version: required_snapshot_column(&row, "envelope_sender_key_version")?,
        recipient_key_version: required_snapshot_column(&row, "envelope_recipient_key_version")?,
        sender_id: required_snapshot_column(&row, "envelope_sender_id")?,
        recipient_id: required_snapshot_column(&row, "envelope_recipient_id")?,
        node_id: required_snapshot_column(&row, "envelope_node_id")?,
        record_version: required_snapshot_column(&row, "envelope_record_version")?,
        previous_record_hash: row.get("envelope_previous_record_hash"),
        sender_x25519_public_key: required_snapshot_column(
            &row,
            "envelope_sender_x25519_public_key",
        )?,
        sender_ed25519_public_key: required_snapshot_column(
            &row,
            "envelope_sender_ed25519_public_key",
        )?,
        sender_fingerprint_sha256: required_snapshot_column(
            &row,
            "envelope_sender_fingerprint_sha256",
        )?,
    };

    let directory_cbor: Option<Vec<u8>> = row.get("directory_cbor");
    let directory = directory_cbor
        .map(|canonical_cbor| -> Result<_> {
            Ok(SharedDirectorySnapshot {
                canonical_cbor,
                signature: required_snapshot_column(&row, "directory_signature")?,
                wrapper_set_root: required_snapshot_column(&row, "directory_wrapper_set_root")?,
                wrapper_count: required_snapshot_column(&row, "directory_wrapper_count")?,
                signer_key_version: required_snapshot_column(&row, "directory_signer_key_version")?,
            })
        })
        .transpose()?;

    Ok(SharedDownloadSnapshot {
        share_id: row.get("share_id"),
        owner_id: row.get("owner_id"),
        root_node_id: row.get("root_node_id"),
        active_epoch: row.get("active_epoch"),
        share_record_version: row.get("share_record_version"),
        share_previous_record_hash: row.get("share_previous_record_hash"),
        recipient_key_version: row.get("recipient_key_version"),
        epoch_protocol_version: row.get("epoch_protocol_version"),
        epoch_wrapper_set_root: row.get("epoch_wrapper_set_root"),
        epoch_wrapper_count: row.get("epoch_wrapper_count"),
        entry_type: row.get("entry_type"),
        current_generation_number: row.get("current_generation_number"),
        current_generation_id: row.get("current_generation_id"),
        bootstrap_cbor: row.get("bootstrap_cbor"),
        bootstrap_signature: row.get("bootstrap_signature"),
        encrypted_manifest: row.get("encrypted_manifest"),
        signer_key_version: row.get("signer_key_version"),
        node_record_version: row.get("node_record_version"),
        record_hash: row.get("record_hash"),
        node_signer_ed25519_public_key: row.get("node_signer_ed25519_public_key"),
        ciphertext_length: row.get("ciphertext_length"),
        crypto_chunk_bytes: row.get("crypto_chunk_bytes"),
        chunk_count: row.get("chunk_count"),
        ciphertext_merkle_root: row.get("ciphertext_merkle_root"),
        wrappers,
        envelope,
        directory,
    })
}

fn required_snapshot_column<T>(row: &tokio_postgres::Row, name: &str) -> Result<T>
where
    T: for<'a> tokio_postgres::types::FromSql<'a>,
{
    row.get::<_, Option<T>>(name).ok_or_else(|| {
        error::ErrorInternalServerError(format!("shared download snapshot is missing {name}"))
    })
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
        .query_one(MIGRATION_SUMMARY_QUERY, &[&user.id])
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
    if !is_modern_node_id(node_id) && !is_legacy_uuid_node_id(node_id) {
        return Err(error::ErrorBadRequest("node id is invalid"));
    }
    Ok(())
}

fn is_modern_node_id(node_id: &str) -> bool {
    (8..=96).contains(&node_id.len())
        && node_id.starts_with("fil_")
        && node_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_legacy_uuid_node_id(node_id: &str) -> bool {
    let bytes = node_id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        })
        && matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
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

async fn parse_node_publication(
    state: &AppState,
    user_id: &str,
    request: &HttpRequest,
    body: web::Payload,
    allow_parts: bool,
) -> Result<NodePublication> {
    let publication = if is_binary_publication(request) {
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        run_publication_decode(state, user_id, move || {
            vault_wire::decode_node_publication(bytes)
                .map_err(|failure| (400_u16, failure.to_string()))
        })
        .await?
    } else if allow_parts {
        require_json_publication(request)?;
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        run_publication_decode(state, user_id, move || {
            publish_upload_publication_from_json(&bytes)
        })
        .await?
    } else {
        require_json_publication(request)?;
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        run_publication_decode(state, user_id, move || {
            let body = serde_json::from_slice::<PublishRecordRequest>(&bytes)
                .map_err(portable_json_publication_error)?;
            node_publication_from_json(
                Vec::new(),
                body.bootstrap_cbor,
                body.bootstrap_signature,
                body.encrypted_manifest,
                body.wrappers,
            )
            .map_err(portable_publication_error)
        })
        .await?
    };
    if !allow_parts && !publication.parts.is_empty() {
        return Err(error::ErrorBadRequest(
            "record publication cannot contain upload parts",
        ));
    }
    Ok(publication)
}

fn publish_upload_publication_from_json(
    bytes: &[u8],
) -> std::result::Result<NodePublication, (u16, String)> {
    let body = serde_json::from_slice::<PublishUploadRequest>(bytes)
        .map_err(portable_json_publication_error)?;
    node_publication_from_json(
        body.parts,
        body.bootstrap_cbor,
        body.bootstrap_signature,
        body.encrypted_manifest,
        body.wrappers,
    )
    .map_err(portable_publication_error)
}

fn node_publication_from_json(
    parts: Vec<CompletedUploadPartRequest>,
    bootstrap_cbor: String,
    bootstrap_signature: String,
    encrypted_manifest: String,
    wrappers: Vec<String>,
) -> Result<NodePublication> {
    Ok(NodePublication {
        parts: parts
            .into_iter()
            .map(|part| vault_wire::CompletedPart {
                part_number: part.part_number,
                etag: part.etag,
                checksum_sha256: part.checksum_sha256,
            })
            .collect(),
        bootstrap_cbor: Bytes::from(decode_limited(&bootstrap_cbor, 65_536, "bootstrap record")?),
        bootstrap_signature: Bytes::copy_from_slice(&decode_fixed::<64>(
            &bootstrap_signature,
            "bootstrap signature",
        )?),
        encrypted_manifest: Bytes::from(decode_limited(
            &encrypted_manifest,
            MAX_MANIFEST_CIPHERTEXT,
            "encrypted manifest",
        )?),
        wrappers: wrappers
            .iter()
            .map(|wrapper| decode_limited(wrapper, 65_536, "key wrapper").map(Bytes::from))
            .collect::<Result<Vec<_>>>()?,
    })
}

async fn parse_share_directory_publication(
    state: &AppState,
    user_id: &str,
    request: &HttpRequest,
    body: web::Payload,
) -> Result<ShareDirectoryPublication> {
    if is_binary_publication(request) {
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        return run_publication_decode(state, user_id, move || {
            vault_wire::decode_share_directory(bytes)
                .map_err(|failure| (400_u16, failure.to_string()))
        })
        .await;
    }
    require_json_publication(request)?;
    let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
    run_publication_decode(state, user_id, move || {
        let body = serde_json::from_slice::<PublishShareDirectoryRequest>(&bytes)
            .map_err(portable_json_publication_error)?;
        let decoded: Result<ShareDirectoryPublication> = (|| {
            Ok(ShareDirectoryPublication {
                directory_cbor: body
                    .directory_cbor
                    .as_deref()
                    .map(|value| decode_limited(value, 4_096, "share directory"))
                    .transpose()?
                    .map(Bytes::from),
                directory_signature: body
                    .directory_signature
                    .as_deref()
                    .map(|value| decode_fixed::<64>(value, "share directory signature"))
                    .transpose()?
                    .map(|value| Bytes::copy_from_slice(&value)),
                wrappers: body
                    .wrappers
                    .iter()
                    .map(|value| decode_limited(value, 65_536, "share wrapper").map(Bytes::from))
                    .collect::<Result<Vec<_>>>()?,
            })
        })();
        decoded.map_err(portable_publication_error)
    })
    .await
}

async fn parse_create_share_publication(
    state: &AppState,
    user_id: &str,
    request: &HttpRequest,
    body: web::Payload,
) -> Result<CreateSharePublication> {
    if is_binary_publication(request) {
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        return run_publication_decode(state, user_id, move || {
            vault_wire::decode_create_share(bytes).map_err(|failure| (400_u16, failure.to_string()))
        })
        .await;
    }
    require_json_publication(request)?;
    let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
    run_publication_decode(state, user_id, move || {
        create_share_publication_from_json(&bytes)
    })
    .await
}

fn create_share_publication_from_json(
    bytes: &[u8],
) -> std::result::Result<CreateSharePublication, (u16, String)> {
    let body = serde_json::from_slice::<CreateShareRequest>(bytes)
        .map_err(portable_json_publication_error)?;
    let decoded: Result<CreateSharePublication> = (|| {
        Ok(CreateSharePublication {
            share_id: body.share_id,
            root_node_id: body.root_node_id,
            recipient_id: body.recipient_id,
            recipient_key_version: body.recipient_key_version,
            wrappers: body
                .wrappers
                .iter()
                .map(|value| decode_limited(value, 65_536, "share wrapper").map(Bytes::from))
                .collect::<Result<Vec<_>>>()?,
            envelopes: signed_envelopes_from_json(body.envelopes)?,
            owner_epoch_key: owner_epoch_key_from_json(body.owner_epoch_key)?,
        })
    })();
    decoded.map_err(portable_publication_error)
}

async fn parse_publish_epoch_publication(
    state: &AppState,
    user_id: &str,
    request: &HttpRequest,
    body: web::Payload,
) -> Result<PublishEpochPublication> {
    if is_binary_publication(request) {
        let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
        return run_publication_decode(state, user_id, move || {
            vault_wire::decode_publish_epoch(bytes)
                .map_err(|failure| (400_u16, failure.to_string()))
        })
        .await;
    }
    require_json_publication(request)?;
    let bytes = read_publication_body(request, body, VAULT_PUBLISH_JSON_LIMIT).await?;
    run_publication_decode(state, user_id, move || {
        let body = serde_json::from_slice::<PublishEpochRequest>(&bytes)
            .map_err(portable_json_publication_error)?;
        let decoded: Result<PublishEpochPublication> = (|| {
            Ok(PublishEpochPublication {
                fence_snapshot_hash: Bytes::copy_from_slice(&decode_fixed::<32>(
                    &body.fence_snapshot_hash,
                    "fence snapshot hash",
                )?),
                wrappers: body
                    .wrappers
                    .iter()
                    .map(|value| decode_limited(value, 65_536, "share wrapper").map(Bytes::from))
                    .collect::<Result<Vec<_>>>()?,
                envelopes: signed_envelopes_from_json(body.envelopes)?,
                owner_epoch_key: owner_epoch_key_from_json(body.owner_epoch_key)?,
            })
        })();
        decoded.map_err(portable_publication_error)
    })
    .await
}

async fn run_publication_decode<T, Operation>(
    state: &AppState,
    user_id: &str,
    operation: Operation,
) -> Result<T>
where
    T: Send + 'static,
    Operation: FnOnce() -> std::result::Result<T, (u16, String)> + Send + 'static,
{
    state
        .vault_validation
        .run(user_id, operation)
        .await
        .map_err(vault_validation_error)?
        .map_err(publication_body_error)
}

fn portable_publication_error(error: actix_web::Error) -> (u16, String) {
    (
        error.as_response_error().status_code().as_u16(),
        error.to_string(),
    )
}

fn portable_json_publication_error(error: serde_json::Error) -> (u16, String) {
    (400, format!("vault publication JSON is invalid: {error}"))
}

fn encode_json_response<T: Serialize>(value: &T) -> std::result::Result<Bytes, (u16, String)> {
    serde_json::to_vec(value)
        .map(Bytes::from)
        .map_err(|failure| (500, failure.to_string()))
}

fn publication_body_error((status, message): (u16, String)) -> actix_web::Error {
    match status {
        409 => error::ErrorConflict(message),
        413 => error::ErrorPayloadTooLarge(message),
        500..=599 => error::ErrorInternalServerError(message),
        _ => error::ErrorBadRequest(message),
    }
}

fn signed_envelopes_from_json(
    envelopes: Vec<SignedEnvelopeRequest>,
) -> Result<Vec<SignedEnvelope>> {
    envelopes
        .into_iter()
        .map(|envelope| {
            Ok(SignedEnvelope {
                canonical_cbor: Bytes::from(decode_limited(
                    &envelope.canonical_cbor,
                    131_072,
                    "share envelope",
                )?),
                signature: Bytes::copy_from_slice(&decode_fixed::<64>(
                    &envelope.signature,
                    "share envelope signature",
                )?),
            })
        })
        .collect()
}

fn owner_epoch_key_from_json(owner: OwnerEpochKeyRequest) -> Result<OwnerEpochKey> {
    Ok(OwnerEpochKey {
        wrapper_id: Bytes::copy_from_slice(&decode_fixed::<16>(
            &owner.wrapper_id,
            "owner epoch wrapper id",
        )?),
        ciphertext: Bytes::copy_from_slice(&decode_fixed::<48>(
            &owner.ciphertext,
            "owner epoch ciphertext",
        )?),
    })
}

fn is_binary_publication(request: &HttpRequest) -> bool {
    request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| {
            value
                .trim()
                .eq_ignore_ascii_case(VAULT_PUBLICATION_CONTENT_TYPE)
        })
}

fn require_json_publication(request: &HttpRequest) -> Result<()> {
    let media_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if media_type.as_deref().is_some_and(|value| {
        value == "application/json"
            || (value.starts_with("application/") && value.ends_with("+json"))
    }) {
        return Ok(());
    }
    Err(error::ErrorUnsupportedMediaType(
        "vault publication Content-Type must be application/json",
    ))
}

async fn read_publication_body(
    request: &HttpRequest,
    mut body: web::Payload,
    limit: usize,
) -> Result<Bytes> {
    let declared = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared.is_some_and(|length| length > limit) {
        return Err(error::ErrorPayloadTooLarge(
            "vault publication is too large",
        ));
    }
    let mut bytes = BytesMut::with_capacity(declared.unwrap_or_default().min(limit));
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(error::ErrorBadRequest)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(error::ErrorPayloadTooLarge(
                "vault publication is too large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.freeze())
}

fn vault_validation_error(error: VaultValidationError) -> actix_web::Error {
    match error {
        VaultValidationError::Busy => {
            error::ErrorTooManyRequests("vault validation queue is full; retry shortly")
        }
        VaultValidationError::Worker(_) => {
            error::ErrorServiceUnavailable("vault validation worker failed")
        }
    }
}

fn publication_validation_error((conflict, message): (bool, String)) -> actix_web::Error {
    if conflict {
        error::ErrorConflict(message)
    } else {
        error::ErrorBadRequest(message)
    }
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
    fn node_id_validation_accepts_modern_and_legacy_ids() {
        assert!(validate_node_id("fil_test").is_ok());
        assert!(validate_node_id("0cd06ddb-e797-4e7d-baf3-caa3a7880544").is_ok());
    }

    #[test]
    fn node_id_validation_rejects_malformed_ids() {
        for node_id in [
            "fil_abc",
            "0CD06DDB-E797-4E7D-BAF3-CAA3A7880544",
            "0cd06ddbe7974e7dbaf3caa3a7880544",
            "0cd06ddb-e797-0e7d-baf3-caa3a7880544",
            "0cd06ddb-e797-4e7d-7af3-caa3a7880544",
        ] {
            assert!(validate_node_id(node_id).is_err(), "accepted {node_id}");
        }
    }

    #[test]
    fn metadata_plan_batches_are_bounded_ancestor_first_and_storage_free() {
        assert!(OWNED_METADATA_PLANS_QUERY.contains("unnest($1::text[]) WITH ORDINALITY"));
        assert!(OWNED_METADATA_PLANS_QUERY.contains("WITH RECURSIVE requested"));
        assert!(OWNED_METADATA_PLANS_QUERY.contains("candidates.depth DESC"));
        assert!(OWNED_METADATA_WRAPPERS_QUERY.contains("wrappers.node_id = ANY($1)"));
        assert!(!OWNED_METADATA_PLANS_QUERY.contains("object_key"));
        assert!(!OWNED_METADATA_PLANS_QUERY.contains("vault_object_generations"));

        let source = include_str!("vault.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        let handler = source_between(
            production,
            "pub async fn metadata_plans(",
            "fn owned_metadata_plan_from_row(",
        );
        assert!(handler.contains("MAX_METADATA_PLAN_REQUEST_NODES"));
        assert!(handler.contains("SHARED_METADATA_PLAN_CONCURRENCY"));
        assert!(handler.contains("load_shared_metadata_plan"));
        let shared_metadata = source_between(
            production,
            "async fn load_shared_metadata_plan(",
            "fn shared_download_snapshot_from_row(",
        );
        assert!(shared_metadata.contains("load_shared_plan(state, user, node_id, false, false)"));
    }

    #[test]
    fn publication_pipeline_stays_decode_once_bounded_and_binary_first() {
        let source = include_str!("vault.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);

        assert!(!production.contains("decode_wrapper("));
        assert!(production.contains(".map(decode_wrapper_material)"));
        assert!(production.contains("let wrapper = decode_wrapper_material(canonical)"));
        assert!(production.contains("application/vnd.aeralyth.vault-publication"));
        assert!(production.contains("vault_wire::decode_node_publication"));
        let legacy_json_parser =
            ["serde_json::from_slice", "::<", "PublishUploadRequest>"].concat();
        assert!(production.contains(&legacy_json_parser));

        for (start, end) in [
            (
                "async fn parse_node_publication(",
                "fn node_publication_from_json(",
            ),
            (
                "async fn parse_share_directory_publication(",
                "async fn parse_create_share_publication(",
            ),
            (
                "async fn parse_create_share_publication(",
                "async fn parse_publish_epoch_publication(",
            ),
            (
                "async fn parse_publish_epoch_publication(",
                "async fn run_publication_decode<",
            ),
        ] {
            let body = source_between(production, start, end);
            assert!(
                body.contains("run_publication_decode"),
                "{start} must offload both binary and JSON/base64 publication decoding"
            );
            assert!(
                body.contains("serde_json::from_slice")
                    || body.contains("create_share_publication_from_json"),
                "{start} must offload legacy JSON deserialization with its base64 conversion"
            );
        }

        let publish_upload = source_between(
            production,
            "pub async fn publish_upload(",
            "pub async fn publish_record(",
        );
        assert_markers_in_order(
            publish_upload,
            &["release_request_connection", "validate_completed_parts"],
        );
        assert!(publish_upload.contains("run_publication_decode"));

        let e2ee = include_str!("../e2ee.rs");
        assert!(e2ee.contains("#[derive(Debug, Eq, PartialEq)]\npub struct DecodedWrapper"));
        for (start, end) in [
            (
                "async fn committed_share_wrappers<'a>(",
                "async fn publication_share_wrappers<'a>(",
            ),
            (
                "async fn publication_share_wrappers<'a>(",
                "async fn update_share_sync_job(",
            ),
        ] {
            let body = source_between(production, start, end);
            assert!(body.contains("Vec<&'a ShareWrapperMaterial>"));
            assert!(!body.contains("wrapper.clone()"));
        }

        for (start, end) in [
            (
                "pub async fn publish_share_directory(",
                "pub async fn create_share(",
            ),
            ("pub async fn create_share(", "pub async fn list_shares("),
            (
                "pub async fn pending_epoch_rotation(",
                "pub async fn begin_epoch_rotation(",
            ),
            (
                "pub async fn begin_epoch_rotation(",
                "async fn load_epoch_rotation_recipients(",
            ),
            (
                "pub async fn publish_epoch_rotation(",
                "pub async fn abort_epoch_rotation(",
            ),
            (
                "async fn decode_and_verify_node_record(",
                "fn validate_record_for_upload(",
            ),
        ] {
            let body = production
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(body, _)| body)
                .expect("validation path should remain inspectable");
            assert!(
                body.contains("vault_validation") || body.contains("run_publication_decode"),
                "{start} must keep CPU-heavy work off Actix workers"
            );
        }
    }

    #[actix_web::test]
    async fn node_publication_route_pipeline_decodes_each_wrapper_once() {
        let manifest = Bytes::from_static(b"encrypted-manifest-with-tag");
        let wrapper = encode_route_wrapper_fixture();
        let wrapper_hash = sha256(&wrapper);
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let bootstrap = encode_route_bootstrap_fixture(sha256(&manifest), wrapper_hash);
        let signature = signing_key.sign(&bootstrap).to_bytes();
        let calls = crate::state::VaultValidationService::new(1, 1, 2, 2)
            .run("user-route-test", move || {
                crate::e2ee::reset_wrapper_decode_calls();
                let decoded = validate_node_publication_material(
                    NodePublication {
                        parts: Vec::new(),
                        bootstrap_cbor: Bytes::from(bootstrap),
                        bootstrap_signature: Bytes::copy_from_slice(&signature),
                        encrypted_manifest: manifest,
                        wrappers: vec![Bytes::from(wrapper)],
                    },
                    vec![(1, signing_key.verifying_key().to_bytes().to_vec())],
                )
                .expect("the route validation fixture should be accepted");
                validate_record_for_upload(
                    &decoded,
                    &VaultUpload {
                        id: "upl_test".to_owned(),
                        node_id: "fil_test".to_owned(),
                        parent_id: None,
                        entry_type: "file".to_owned(),
                        generation_number: 1,
                        generation_id: vec![3_u8; 16],
                        object_key: None,
                        ciphertext_length: 25,
                        chunk_count: 1,
                        mode: "single".to_owned(),
                        part_size_bytes: None,
                        multipart_upload_id: None,
                        status: "pending".to_owned(),
                        checksum_sha256: None,
                    },
                )
                .unwrap();
                validate_owner_wrappers(&decoded, None).unwrap();
                crate::e2ee::wrapper_decode_calls()
            })
            .await
            .unwrap();
        assert_eq!(
            calls, 1,
            "the blocking route pipeline must decode once and reuse typed wrapper material"
        );
    }

    #[test]
    fn database_leases_are_released_before_blocking_validation() {
        let source = include_str!("vault.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);

        for (start, end) in [
            ("pub async fn share_plan(", "pub async fn share_contexts("),
            (
                "pub async fn pending_epoch_rotation(",
                "pub async fn begin_epoch_rotation(",
            ),
        ] {
            let body = source_between(production, start, end);
            assert_markers_in_order(
                body,
                &[".commit()", "drop(client)", "run_publication_decode"],
            );
        }

        let begin = source_between(
            production,
            "pub async fn begin_epoch_rotation(",
            "async fn load_epoch_rotation_recipients(",
        );
        assert_markers_in_order(begin, &[".commit()", "drop(client)", ".vault_validation"]);
        assert!(
            begin.matches("drop(client)").count() >= 2,
            "both rotation read and write transactions must release their leases"
        );

        let create = source_between(
            production,
            "pub async fn create_share(",
            "pub async fn list_shares(",
        );
        assert_markers_in_order(
            create,
            &[
                "read_owned_subtree_snapshot",
                ".vault_validation",
                "let mut client = state",
            ],
        );

        let publish = source_between(
            production,
            "pub async fn publish_epoch_rotation(",
            "pub async fn abort_epoch_rotation(",
        );
        assert_markers_in_order(
            publish,
            &[
                ".commit()",
                "drop(client)",
                ".vault_validation",
                "let mut client = state",
            ],
        );

        let directory = source_between(
            production,
            "pub async fn publish_share_directory(",
            "pub async fn create_share(",
        );
        assert_markers_in_order(
            directory,
            &[
                ".commit()",
                "drop(client)",
                ".vault_validation",
                "let mut client = state",
            ],
        );

        let unlock = source_between(
            production,
            "pub async fn unlock_material(",
            "pub async fn rewrap(",
        );
        assert_markers_in_order(
            unlock,
            &[
                "release_request_connection",
                "run_publication_decode",
                "encode_json_response",
            ],
        );

        let download = source_between(
            production,
            "pub async fn download_plan(",
            "pub async fn abort_upload(",
        );
        assert_markers_in_order(
            download,
            &[
                "release_request_connection",
                ".download_url(",
                "run_publication_decode",
                "encode_json_response",
            ],
        );

        let shared = source_between(
            production,
            "async fn load_shared_plan(",
            "enum SharedDownloadCpuResponse",
        );
        assert_markers_in_order(
            shared,
            &[
                ".commit()",
                "drop(client)",
                ".download_url(",
                "run_publication_decode",
                "encode_json_response",
            ],
        );

        let snapshot = source_between(
            production,
            "async fn subtree_snapshot(",
            "fn snapshot_hash(",
        );
        assert!(snapshot.contains("WITH ORDINALITY"));
        assert!(snapshot.contains("ORDER BY requested.ordinal"));
        assert!(!snapshot.contains("sort_"));
    }

    #[test]
    fn legacy_json_publications_remain_a_compatible_fallback() {
        let publication = node_publication_from_json(
            Vec::new(),
            encode_bytes([1_u8, 2, 3]),
            encode_bytes([4_u8; 64]),
            encode_bytes([5_u8; 16]),
            vec![encode_bytes([6_u8, 7, 8])],
        )
        .unwrap();
        assert_eq!(publication.bootstrap_cbor.as_ref(), &[1, 2, 3]);
        assert_eq!(publication.bootstrap_signature.as_ref(), &[4_u8; 64]);
        assert_eq!(publication.encrypted_manifest.as_ref(), &[5_u8; 16]);
        assert_eq!(publication.wrappers[0].as_ref(), &[6, 7, 8]);

        let request = actix_web::test::TestRequest::post()
            .insert_header((CONTENT_TYPE, VAULT_PUBLICATION_CONTENT_TYPE))
            .to_http_request();
        assert!(is_binary_publication(&request));

        let request = actix_web::test::TestRequest::post()
            .insert_header((CONTENT_TYPE, "application/json; charset=utf-8"))
            .to_http_request();
        assert!(require_json_publication(&request).is_ok());
        let request = actix_web::test::TestRequest::post()
            .insert_header((CONTENT_TYPE, "application/vnd.aeralyth+json"))
            .to_http_request();
        assert!(require_json_publication(&request).is_ok());
        let request = actix_web::test::TestRequest::post()
            .insert_header((CONTENT_TYPE, "text/plain"))
            .to_http_request();
        assert_eq!(
            require_json_publication(&request)
                .unwrap_err()
                .as_response_error()
                .status_code(),
            actix_web::http::StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            publication_body_error((409, "stale snapshot".to_owned()))
                .as_response_error()
                .status_code(),
            actix_web::http::StatusCode::CONFLICT
        );
    }

    #[test]
    fn representative_share_server_parse_compares_binary_with_actual_legacy_json() {
        const WRAPPER_COUNT: usize = 1_024;
        const ENVELOPE_COUNT: usize = 128;
        const SAMPLES: usize = 7;
        let wrapper = vec![7_u8; 4 * 1_024];
        let envelope = vec![8_u8; 512];
        let signature = vec![9_u8; 64];
        let wrapper_text = encode_bytes(&wrapper);
        let envelope_text = encode_bytes(&envelope);
        let signature_text = encode_bytes(&signature);
        let json = serde_json::to_vec(&serde_json::json!({
            "shareId": "shr_representative",
            "rootNodeId": "fil_representative",
            "recipientId": "usr_representative",
            "recipientKeyVersion": 7,
            "wrappers": vec![wrapper_text; WRAPPER_COUNT],
            "envelopes": (0..ENVELOPE_COUNT)
                .map(|_| serde_json::json!({
                    "canonicalCbor": envelope_text,
                    "signature": signature_text,
                }))
                .collect::<Vec<_>>(),
            "ownerEpochKey": {
                "wrapperId": encode_bytes([3_u8; 16]),
                "ciphertext": encode_bytes([4_u8; 48]),
            },
        }))
        .unwrap();
        assert!(json.len() < VAULT_PUBLISH_JSON_LIMIT);

        let mut binary = vec![b'A', b'V', b'L', b'T', 1, 3, 0, 0];
        push_wire_bytes(&mut binary, b"shr_representative");
        push_wire_bytes(&mut binary, b"fil_representative");
        push_wire_bytes(&mut binary, b"usr_representative");
        binary.extend_from_slice(&7_u64.to_be_bytes());
        push_wire_u32(&mut binary, WRAPPER_COUNT as u32);
        for _ in 0..WRAPPER_COUNT {
            push_wire_bytes(&mut binary, &wrapper);
        }
        push_wire_u32(&mut binary, ENVELOPE_COUNT as u32);
        for _ in 0..ENVELOPE_COUNT {
            push_wire_bytes(&mut binary, &envelope);
            push_wire_bytes(&mut binary, &signature);
        }
        push_wire_bytes(&mut binary, &[3_u8; 16]);
        push_wire_bytes(&mut binary, &[4_u8; 48]);
        let binary = Bytes::from(binary);

        std::hint::black_box(vault_wire::decode_create_share(binary.clone()).unwrap());
        std::hint::black_box(create_share_publication_from_json(&json).unwrap());
        let mut binary_micros = Vec::with_capacity(SAMPLES);
        let mut json_micros = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let started = std::time::Instant::now();
            std::hint::black_box(vault_wire::decode_create_share(binary.clone()).unwrap());
            binary_micros.push(started.elapsed().as_micros());

            let started = std::time::Instant::now();
            let publication = create_share_publication_from_json(&json).unwrap();
            assert_eq!(publication.wrappers.len(), WRAPPER_COUNT);
            assert_eq!(publication.envelopes.len(), ENVELOPE_COUNT);
            std::hint::black_box(publication);
            json_micros.push(started.elapsed().as_micros());
        }
        binary_micros.sort_unstable();
        json_micros.sort_unstable();
        let binary_median = binary_micros[SAMPLES / 2];
        let json_median = json_micros[SAMPLES / 2];
        assert!(binary_median < json_median);
        println!(
            "{{\"metric\":\"vault_server_share_publication_parse\",\"binaryBytes\":{},\"legacyJsonBytes\":{},\"samples\":{SAMPLES},\"binaryMedianMicros\":{binary_median},\"legacyJsonMedianMicros\":{json_median}}}",
            binary.len(),
            json.len(),
        );
    }

    #[test]
    fn representative_node_server_parse_is_zero_copy_and_beats_actual_legacy_json() {
        const WRAPPER_COUNT: usize = 64;
        const SAMPLES: usize = 7;
        let bootstrap = vec![3_u8; 8 * 1_024];
        let signature = vec![4_u8; 64];
        let manifest = vec![5_u8; 1_024 * 1_024];
        let wrapper = vec![6_u8; 8 * 1_024];
        let json = serde_json::to_vec(&serde_json::json!({
            "parts": [],
            "bootstrapCbor": encode_bytes(&bootstrap),
            "bootstrapSignature": encode_bytes(&signature),
            "encryptedManifest": encode_bytes(&manifest),
            "wrappers": vec![encode_bytes(&wrapper); WRAPPER_COUNT],
        }))
        .unwrap();
        assert!(json.len() < VAULT_PUBLISH_JSON_LIMIT);

        let mut binary = vec![b'A', b'V', b'L', b'T', 1, 1, 0, 0];
        push_wire_u32(&mut binary, 0);
        push_wire_bytes(&mut binary, &bootstrap);
        push_wire_bytes(&mut binary, &signature);
        push_wire_bytes(&mut binary, &manifest);
        push_wire_u32(&mut binary, WRAPPER_COUNT as u32);
        for _ in 0..WRAPPER_COUNT {
            push_wire_bytes(&mut binary, &wrapper);
        }
        let binary = Bytes::from(binary);
        let allocation_start = binary.as_ptr() as usize;
        let allocation_end = allocation_start + binary.len();
        let decoded = vault_wire::decode_node_publication(binary.clone()).unwrap();
        let copied_binary_field_bytes = decoded
            .wrappers
            .iter()
            .chain([
                &decoded.bootstrap_cbor,
                &decoded.bootstrap_signature,
                &decoded.encrypted_manifest,
            ])
            .filter(|field| {
                let start = field.as_ptr() as usize;
                start < allocation_start || start + field.len() > allocation_end
            })
            .map(|field| field.len())
            .sum::<usize>();
        assert_eq!(copied_binary_field_bytes, 0);

        std::hint::black_box(publish_upload_publication_from_json(&json).unwrap());
        let mut binary_micros = Vec::with_capacity(SAMPLES);
        let mut json_micros = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let started = std::time::Instant::now();
            std::hint::black_box(vault_wire::decode_node_publication(binary.clone()).unwrap());
            binary_micros.push(started.elapsed().as_micros());

            let started = std::time::Instant::now();
            let publication = publish_upload_publication_from_json(&json).unwrap();
            assert_eq!(publication.wrappers.len(), WRAPPER_COUNT);
            std::hint::black_box(publication);
            json_micros.push(started.elapsed().as_micros());
        }
        binary_micros.sort_unstable();
        json_micros.sort_unstable();
        let binary_median = binary_micros[SAMPLES / 2];
        let json_median = json_micros[SAMPLES / 2];
        assert!(binary_median < json_median);
        println!(
            "{{\"metric\":\"vault_server_node_publication_parse\",\"binaryBytes\":{},\"legacyJsonBytes\":{},\"samples\":{SAMPLES},\"binaryMedianMicros\":{binary_median},\"legacyJsonMedianMicros\":{json_median},\"copiedBinaryFieldBytes\":{copied_binary_field_bytes}}}",
            binary.len(),
            json.len(),
        );
    }

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
    fn shared_download_snapshot_releases_locks_before_response_work() {
        assert!(
            SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("FOR SHARE OF shares, recipients"),
            "the authorization snapshot must conflict with epoch rotation until copied"
        );
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("recipients.status = 'active'"));
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("shares.status = 'active'"));
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("wrapper_snapshot AS MATERIALIZED"));
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("LEFT JOIN LATERAL"));

        let source = include_str!("vault.rs");
        let handler = source
            .split_once("async fn load_shared_plan(")
            .and_then(|(_, tail)| tail.split_once("enum SharedDownloadCpuResponse"))
            .map(|(handler, _)| handler)
            .expect("shared download handler should remain inspectable");
        assert_eq!(handler.matches(".query_opt(").count(), 1);
        let commit = handler.find(".commit()").expect("snapshot must commit");
        let release = handler
            .find("drop(client)")
            .expect("snapshot connection must be returned");
        assert!(commit < release);
        for work in [
            "shared_download_snapshot_from_row(row)",
            "decode_share_envelope",
            ".download_url(",
            "encode_bytes(",
        ] {
            assert!(
                release
                    < handler
                        .find(work)
                        .expect("response work must remain visible"),
                "{work} moved back inside the shared download transaction"
            );
        }
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_query_contracts_prepare() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("connect to PostgreSQL");
        actix_web::rt::spawn(async move {
            connection
                .await
                .expect("PostgreSQL connection stays healthy");
        });

        client
            .prepare(SHARED_DOWNLOAD_SNAPSHOT_QUERY)
            .await
            .expect("shared download snapshot query should prepare");
        client
            .prepare(OWNED_METADATA_PLANS_QUERY)
            .await
            .expect("owned metadata batch query should prepare");
        client
            .prepare(OWNED_METADATA_WRAPPERS_QUERY)
            .await
            .expect("owned metadata wrapper batch query should prepare");
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_optimized_queries_execute() {
        use tokio_postgres::error::SqlState;

        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let (mut snapshot_client, snapshot_connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect snapshot client to PostgreSQL");
        actix_web::rt::spawn(async move {
            snapshot_connection
                .await
                .expect("snapshot PostgreSQL connection stays healthy");
        });
        let (contender, contender_connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("connect contender client to PostgreSQL");
        actix_web::rt::spawn(async move {
            contender_connection
                .await
                .expect("contender PostgreSQL connection stays healthy");
        });

        snapshot_client
            .batch_execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                   VALUES
                     ('usr_perf_share_owner', 'perf_share_owner', 'not-a-login-hash', 'user', 'active'),
                     ('usr_perf_share_recipient', 'perf_share_recipient', 'not-a-login-hash', 'user', 'active');
                 INSERT INTO vault_identity_keys (
                   user_id, key_version, x25519_public_key, ed25519_public_key,
                   fingerprint_sha256, status
                 ) VALUES
                   ('usr_perf_share_owner', 1, decode(repeat('11', 32), 'hex'),
                    decode(repeat('12', 32), 'hex'), decode(repeat('13', 32), 'hex'), 'active'),
                   ('usr_perf_share_recipient', 1, decode(repeat('21', 32), 'hex'),
                    decode(repeat('22', 32), 'hex'), decode(repeat('23', 32), 'hex'), 'active');
                 INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes, entry_type,
                   e2ee_state, current_generation_number, current_generation_id
                 ) VALUES (
                   'fil_perf_share_root', 'usr_perf_share_owner', 'shared-root',
                   'perf-share/root', 0, 'folder', 'encrypted', 1,
                   decode(repeat('31', 16), 'hex')
                 );
                 INSERT INTO vault_node_records (
                   node_id, owner_id, record_version, record_hash,
                   bootstrap_cbor, bootstrap_signature, encrypted_manifest,
                   manifest_hash, signer_key_version
                 ) VALUES (
                   'fil_perf_share_root', 'usr_perf_share_owner', 1,
                   decode(repeat('32', 32), 'hex'), decode(repeat('33', 128), 'hex'),
                   decode(repeat('34', 64), 'hex'), decode(repeat('35', 16), 'hex'),
                   decode(repeat('36', 32), 'hex'), 1
                 );
                 INSERT INTO vault_node_heads (
                   node_id, owner_id, record_version, record_hash
                 ) VALUES (
                   'fil_perf_share_root', 'usr_perf_share_owner', 1,
                   decode(repeat('32', 32), 'hex')
                 );
                 INSERT INTO vault_shares (
                   id, owner_id, root_node_id, active_epoch, status, record_version,
                   record_hash
                 ) VALUES (
                   'shr_perf_snapshot', 'usr_perf_share_owner', 'fil_perf_share_root',
                   1, 'active', 1, decode(repeat('41', 32), 'hex')
                 );
                 INSERT INTO vault_share_epochs (share_id, epoch, status, protocol_version)
                   VALUES ('shr_perf_snapshot', 1, 'published', 1);
                 INSERT INTO vault_share_recipients (
                   share_id, recipient_id, recipient_key_version, status
                 ) VALUES (
                   'shr_perf_snapshot', 'usr_perf_share_recipient', 1, 'active'
                 );
                 INSERT INTO vault_share_envelopes (
                   envelope_id, share_id, epoch, sender_id, sender_key_version,
                   recipient_id, recipient_key_version, node_id, permissions,
                   record_version, encapsulated_key, ciphertext, canonical_cbor,
                   signature, envelope_hash
                 ) VALUES (
                   decode(repeat('42', 16), 'hex'), 'shr_perf_snapshot', 1,
                   'usr_perf_share_owner', 1, 'usr_perf_share_recipient', 1,
                   'fil_perf_share_root', 'read', 1,
                   decode(repeat('43', 32), 'hex'), decode(repeat('44', 48), 'hex'),
                   decode(repeat('45', 128), 'hex'), decode(repeat('46', 64), 'hex'),
                   decode(repeat('47', 32), 'hex')
                 );
                 INSERT INTO vault_share_wrappers (
                   wrapper_id, share_id, epoch, node_id, wrapper_kind,
                   record_version, canonical_cbor, wrapper_hash, commitment_source
                 ) VALUES (
                   decode(repeat('48', 16), 'hex'), 'shr_perf_snapshot', 1,
                   'fil_perf_share_root', 'metadata', 1,
                   decode(repeat('49', 64), 'hex'), decode(repeat('4a', 32), 'hex'),
                   'epoch'
                 );",
            )
            .await
            .expect("shared-download fixture should insert");

        let transaction = snapshot_client
            .transaction()
            .await
            .expect("snapshot transaction should start");
        let row = transaction
            .query_one(
                SHARED_DOWNLOAD_SNAPSHOT_QUERY,
                &[&"fil_perf_share_root", &"usr_perf_share_recipient"],
            )
            .await
            .expect("shared download snapshot should execute");

        contender
            .batch_execute("SET lock_timeout = '100ms'")
            .await
            .expect("contender lock timeout should apply");
        let blocked = contender
            .execute(
                "UPDATE vault_shares SET updated_at = now() WHERE id = 'shr_perf_snapshot'",
                &[],
            )
            .await
            .expect_err("share mutation should wait while the snapshot lock is held");
        assert_eq!(blocked.code(), Some(&SqlState::LOCK_NOT_AVAILABLE));

        transaction
            .commit()
            .await
            .expect("snapshot transaction should commit before response work");
        let snapshot = shared_download_snapshot_from_row(row)
            .expect("owned snapshot values should remain usable after commit");
        assert_eq!(snapshot.share_id, "shr_perf_snapshot");
        assert_eq!(snapshot.wrappers.len(), 1);
        assert_eq!(snapshot.envelope.recipient_id, "usr_perf_share_recipient");
        assert_eq!(
            contender
                .execute(
                    "UPDATE vault_shares SET updated_at = now() WHERE id = 'shr_perf_snapshot'",
                    &[],
                )
                .await
                .expect("share mutation should proceed after snapshot commit"),
            1
        );
        snapshot_client
            .execute(
                "DELETE FROM users WHERE id IN ('usr_perf_share_owner', 'usr_perf_share_recipient')",
                &[],
            )
            .await
            .expect("shared-download fixture should clean up");
    }

    #[test]
    fn latest_share_envelope_query_matches_the_no_sort_index_order() {
        assert!(
            SHARED_DOWNLOAD_SNAPSHOT_QUERY
                .contains("WHERE envelopes.share_id = authorized_share.share_id")
        );
        assert!(
            SHARED_DOWNLOAD_SNAPSHOT_QUERY
                .contains("envelopes.epoch = authorized_share.active_epoch")
        );
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("envelopes.recipient_id = $2"));
        assert!(
            SHARED_DOWNLOAD_SNAPSHOT_QUERY
                .contains("ORDER BY envelopes.created_at DESC, envelopes.envelope_id DESC")
        );
        assert!(SHARED_DOWNLOAD_SNAPSHOT_QUERY.contains("LIMIT 1"));

        let vault_schema = include_str!("../../../database/init/002_e2ee.sql");
        assert!(vault_schema.contains("vault_share_envelopes_recipient_latest_idx"));
    }

    #[test]
    fn migration_queries_stay_aligned_with_their_partial_indexes() {
        assert!(MIGRATION_CLAIM_QUERY.contains("files.e2ee_state IN ('legacy', 'staged')"));
        assert!(MIGRATION_CLAIM_QUERY.contains("ORDER BY files.created_at, files.id"));
        assert!(MIGRATION_CLAIM_QUERY.contains("FOR UPDATE OF files SKIP LOCKED"));
        assert!(MIGRATION_SUMMARY_QUERY.contains("e2ee_state = 'legacy'"));
        assert!(MIGRATION_SUMMARY_QUERY.contains("e2ee_state = 'staged'"));
        assert!(MIGRATION_SUMMARY_QUERY.contains("state <> 'complete'"));

        let vault_schema = include_str!("../../../database/init/002_e2ee.sql");
        assert!(vault_schema.contains("files_e2ee_migration_claim_idx"));
        assert!(vault_schema.contains("vault_migrations_incomplete_owner_idx"));
        assert!(vault_schema.contains("vault_migrations_cleanup_object_idx"));
    }

    #[test]
    fn share_epoch_guards_stay_set_wise() {
        let vault_schema = include_str!("../../../database/init/002_e2ee.sql");
        assert_eq!(
            vault_schema
                .matches("REFERENCING NEW TABLE AS new_share_writes")
                .count(),
            4
        );
        assert!(!vault_schema.contains("BEFORE INSERT OR UPDATE ON vault_share_envelopes"));
        assert!(!vault_schema.contains("BEFORE INSERT OR UPDATE ON vault_share_wrappers"));
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

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        source
            .split_once(start)
            .and_then(|(_, tail)| tail.split_once(end))
            .map(|(body, _)| body)
            .expect("validation path should remain inspectable")
    }

    fn assert_markers_in_order(source: &str, markers: &[&str]) {
        let mut remaining = source;
        for marker in markers {
            let (_, tail) = remaining
                .split_once(marker)
                .unwrap_or_else(|| panic!("expected `{marker}` after the preceding marker"));
            remaining = tail;
        }
    }

    fn encode_route_bootstrap_fixture(manifest_hash: [u8; 32], wrapper_hash: [u8; 32]) -> Vec<u8> {
        let mut output = vec![0xaf];
        push_test_uint_pair(&mut output, 1, 1);
        push_test_uint_pair(&mut output, 2, 1);
        push_test_uint_pair(&mut output, 3, 1);
        push_test_key(&mut output, 4);
        push_test_text(&mut output, b"fil_test");
        push_test_uint_pair(&mut output, 5, 1);
        push_test_key(&mut output, 6);
        push_test_bytes(&mut output, &[3_u8; 16]);
        push_test_key(&mut output, 7);
        push_test_bytes(&mut output, &[0_u8; 12]);
        push_test_key(&mut output, 8);
        output.push(0x81);
        push_test_bytes(&mut output, &[4_u8; 16]);
        push_test_uint_pair(&mut output, 9, 25);
        push_test_uint_pair(&mut output, 10, 1);
        push_test_uint_pair(&mut output, 11, 1);
        push_test_key(&mut output, 12);
        output.push(0xf6);
        push_test_key(&mut output, 13);
        push_test_bytes(&mut output, &manifest_hash);
        push_test_key(&mut output, 14);
        output.push(0x81);
        push_test_bytes(&mut output, &wrapper_hash);
        push_test_key(&mut output, 15);
        push_test_bytes(&mut output, &[5_u8; 32]);
        output
    }

    fn encode_route_wrapper_fixture() -> Vec<u8> {
        let mut output = vec![0xab];
        push_test_uint_pair(&mut output, 1, 1);
        push_test_key(&mut output, 2);
        push_test_bytes(&mut output, &[4_u8; 16]);
        push_test_uint_pair(&mut output, 3, 1);
        push_test_key(&mut output, 4);
        push_test_text(&mut output, b"fil_test");
        for key in [5_u8, 6, 7, 8] {
            push_test_key(&mut output, key);
            output.push(0xf6);
        }
        push_test_uint_pair(&mut output, 9, 1);
        push_test_key(&mut output, 10);
        push_test_bytes(&mut output, &[9_u8; 48]);
        push_test_uint_pair(&mut output, 11, 1);
        output
    }

    fn push_test_uint_pair(output: &mut Vec<u8>, key: u8, value: u8) {
        push_test_key(output, key);
        push_test_uint(output, value);
    }

    fn push_test_key(output: &mut Vec<u8>, key: u8) {
        push_test_uint(output, key);
    }

    fn push_test_uint(output: &mut Vec<u8>, value: u8) {
        if value < 24 {
            output.push(value);
        } else {
            output.extend_from_slice(&[0x18, value]);
        }
    }

    fn push_test_bytes(output: &mut Vec<u8>, value: &[u8]) {
        if value.len() < 24 {
            output.push(0x40 | value.len() as u8);
        } else {
            output.extend_from_slice(&[0x58, value.len() as u8]);
        }
        output.extend_from_slice(value);
    }

    fn push_test_text(output: &mut Vec<u8>, value: &[u8]) {
        output.push(0x60 | value.len() as u8);
        output.extend_from_slice(value);
    }

    fn push_wire_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn push_wire_bytes(output: &mut Vec<u8>, value: &[u8]) {
        push_wire_u32(output, value.len() as u32);
        output.extend_from_slice(value);
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
            canonical: Bytes::new(),
            signature: Bytes::new(),
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
