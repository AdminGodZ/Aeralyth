use std::fmt;

#[cfg(test)]
use std::cell::Cell;

use bytes::Bytes;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

pub const FORMAT_VERSION: u64 = 1;
pub const SHARE_ENVELOPE_VERSION: u64 = 2;
pub const SHARE_DIRECTORY_VERSION: u64 = 1;
pub const SUITE_ID: u64 = 1;
pub const AAD_SCHEMA_ID: u64 = 1;
pub const CRYPTO_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
pub const UPLOAD_PART_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_CIPHERTEXT_BYTES: u64 = 2_415_919_104;
pub const ARGON2ID_ALGORITHM: &str = "argon2id13";
pub const ARGON2ID_OPERATIONS: u64 = 3;
pub const ARGON2ID_MEMORY_BYTES: u64 = 256 * 1024 * 1024;
pub const ARGON2ID_OUTPUT_BYTES: u64 = 32;

pub const fn uses_vault_multipart_upload(ciphertext_bytes: u64) -> bool {
    ciphertext_bytes > UPLOAD_PART_BYTES
}

const MAX_WRAPPERS_PER_RECORD: usize = 4_096;
const MAX_SHARE_WRAPPERS: usize = 8_192;

#[cfg(test)]
thread_local! {
    static WRAPPER_DECODE_CALLS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_wrapper_decode_calls() {
    WRAPPER_DECODE_CALLS.with(|calls| calls.set(0));
}

#[cfg(test)]
pub(crate) fn wrapper_decode_calls() -> usize {
    WRAPPER_DECODE_CALLS.with(Cell::get)
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BootstrapRecord {
    pub format_version: u64,
    pub suite_id: u64,
    pub aad_schema_id: u64,
    pub node_id: String,
    pub generation_number: u64,
    pub generation_id: [u8; 16],
    pub manifest_iv: [u8; 12],
    pub wrapper_ids: Vec<[u8; 16]>,
    pub ciphertext_length: u64,
    pub signer_key_version: u64,
    pub record_version: u64,
    pub previous_record_hash: Option<[u8; 32]>,
    pub manifest_hash: [u8; 32],
    pub wrapper_hashes: Vec<[u8; 32]>,
    pub ciphertext_merkle_root: [u8; 32],
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WrapperRecord {
    pub format_version: u64,
    pub wrapper_id: [u8; 16],
    pub kind: u64,
    pub node_id: String,
    pub parent_node_id: Option<String>,
    pub generation_id: Option<[u8; 16]>,
    pub share_id: Option<String>,
    pub epoch: Option<u64>,
    pub record_version: u64,
    pub ciphertext: Vec<u8>,
    pub aad_schema_id: u64,
}

#[derive(Debug, Eq, PartialEq)]
pub struct DecodedWrapper {
    pub canonical: Bytes,
    pub record: WrapperRecord,
    pub hash: [u8; 32],
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ShareEnvelopeRecord {
    pub format_version: u64,
    pub suite_id: u64,
    pub envelope_id: [u8; 16],
    pub share_id: String,
    pub epoch: u64,
    pub sender_id: String,
    pub sender_key_version: u64,
    pub recipient_id: String,
    pub recipient_key_version: u64,
    pub node_id: String,
    pub permissions: u64,
    pub generation_scope: Option<u64>,
    pub record_version: u64,
    pub previous_record_hash: Option<[u8; 32]>,
    pub encapsulated_key: [u8; 32],
    pub ciphertext: Vec<u8>,
    pub aad_schema_id: u64,
    pub wrapper_hashes: Vec<[u8; 32]>,
    pub wrapper_set_root: Option<[u8; 32]>,
    pub wrapper_count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ShareDirectoryRecord {
    pub format_version: u64,
    pub suite_id: u64,
    pub aad_schema_id: u64,
    pub node_id: String,
    pub record_version: u64,
    pub record_hash: [u8; 32],
    pub generation_number: u64,
    pub generation_id: [u8; 16],
    pub signer_key_version: u64,
    pub wrapper_set_root: [u8; 32],
    pub wrapper_count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WrapperSetProof {
    pub wrapper_hash: [u8; 32],
    pub leaf_index: i32,
    pub proof: Vec<u8>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WrapperSetCommitment {
    pub root: [u8; 32],
    pub count: i32,
    pub proofs: Vec<WrapperSetProof>,
}

#[derive(Debug, Clone)]
pub struct VerifiedNodeRecord {
    pub bootstrap: BootstrapRecord,
    pub record_hash: [u8; 32],
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProtocolError(String);

impl ProtocolError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

pub fn decode_bootstrap(input: &[u8]) -> Result<BootstrapRecord, ProtocolError> {
    let mut reader = CborReader::new(input);
    reader.expect_map_len(15)?;
    reader.expect_key(1)?;
    let format_version = reader.read_uint()?;
    reader.expect_key(2)?;
    let suite_id = reader.read_uint()?;
    reader.expect_key(3)?;
    let aad_schema_id = reader.read_uint()?;
    reader.expect_key(4)?;
    let node_id = reader.read_identifier()?;
    reader.expect_key(5)?;
    let generation_number = reader.read_uint()?;
    reader.expect_key(6)?;
    let generation_id = reader.read_fixed_bytes::<16>()?;
    reader.expect_key(7)?;
    let manifest_iv = reader.read_fixed_bytes::<12>()?;
    reader.expect_key(8)?;
    let wrapper_ids = reader.read_fixed_bytes_array::<16>(MAX_WRAPPERS_PER_RECORD)?;
    reader.expect_key(9)?;
    let ciphertext_length = reader.read_uint()?;
    reader.expect_key(10)?;
    let signer_key_version = reader.read_uint()?;
    reader.expect_key(11)?;
    let record_version = reader.read_uint()?;
    reader.expect_key(12)?;
    let previous_record_hash = reader.read_nullable_fixed_bytes::<32>()?;
    reader.expect_key(13)?;
    let manifest_hash = reader.read_fixed_bytes::<32>()?;
    reader.expect_key(14)?;
    let wrapper_hashes = reader.read_fixed_bytes_array::<32>(MAX_WRAPPERS_PER_RECORD)?;
    reader.expect_key(15)?;
    let ciphertext_merkle_root = reader.read_fixed_bytes::<32>()?;
    reader.finish()?;

    let record = BootstrapRecord {
        format_version,
        suite_id,
        aad_schema_id,
        node_id,
        generation_number,
        generation_id,
        manifest_iv,
        wrapper_ids,
        ciphertext_length,
        signer_key_version,
        record_version,
        previous_record_hash,
        manifest_hash,
        wrapper_hashes,
        ciphertext_merkle_root,
    };
    validate_bootstrap(&record)?;

    Ok(record)
}

pub fn decode_share_directory(input: &[u8]) -> Result<ShareDirectoryRecord, ProtocolError> {
    let mut reader = CborReader::new(input);
    reader.expect_map_len(11)?;
    reader.expect_key(1)?;
    let format_version = reader.read_uint()?;
    reader.expect_key(2)?;
    let suite_id = reader.read_uint()?;
    reader.expect_key(3)?;
    let aad_schema_id = reader.read_uint()?;
    reader.expect_key(4)?;
    let node_id = reader.read_identifier()?;
    reader.expect_key(5)?;
    let record_version = reader.read_uint()?;
    reader.expect_key(6)?;
    let record_hash = reader.read_fixed_bytes::<32>()?;
    reader.expect_key(7)?;
    let generation_number = reader.read_uint()?;
    reader.expect_key(8)?;
    let generation_id = reader.read_fixed_bytes::<16>()?;
    reader.expect_key(9)?;
    let signer_key_version = reader.read_uint()?;
    reader.expect_key(10)?;
    let wrapper_set_root = reader.read_fixed_bytes::<32>()?;
    reader.expect_key(11)?;
    let wrapper_count = reader.read_uint()?;
    reader.finish()?;
    if format_version != SHARE_DIRECTORY_VERSION
        || suite_id != SUITE_ID
        || aad_schema_id != AAD_SCHEMA_ID
        || record_version == 0
        || generation_number == 0
        || signer_key_version == 0
        || wrapper_count == 0
        || wrapper_count > MAX_SHARE_WRAPPERS as u64
    {
        return Err(ProtocolError::new(
            "share directory protocol fields are invalid",
        ));
    }
    Ok(ShareDirectoryRecord {
        format_version,
        suite_id,
        aad_schema_id,
        node_id,
        record_version,
        record_hash,
        generation_number,
        generation_id,
        signer_key_version,
        wrapper_set_root,
        wrapper_count,
    })
}

pub fn decode_wrapper(input: &[u8]) -> Result<WrapperRecord, ProtocolError> {
    #[cfg(test)]
    WRAPPER_DECODE_CALLS.with(|calls| calls.set(calls.get() + 1));
    let mut reader = CborReader::new(input);
    reader.expect_map_len(11)?;
    reader.expect_key(1)?;
    let format_version = reader.read_uint()?;
    reader.expect_key(2)?;
    let wrapper_id = reader.read_fixed_bytes::<16>()?;
    reader.expect_key(3)?;
    let kind = reader.read_uint()?;
    reader.expect_key(4)?;
    let node_id = reader.read_identifier()?;
    reader.expect_key(5)?;
    let parent_node_id = reader.read_nullable_identifier()?;
    reader.expect_key(6)?;
    let generation_id = reader.read_nullable_fixed_bytes::<16>()?;
    reader.expect_key(7)?;
    let share_id = reader.read_nullable_identifier()?;
    reader.expect_key(8)?;
    let epoch = reader.read_nullable_uint()?;
    reader.expect_key(9)?;
    let record_version = reader.read_uint()?;
    reader.expect_key(10)?;
    let ciphertext = reader.read_bytes(65_536)?;
    reader.expect_key(11)?;
    let aad_schema_id = reader.read_uint()?;
    reader.finish()?;

    if format_version != FORMAT_VERSION
        || aad_schema_id != AAD_SCHEMA_ID
        || !matches!(kind, 1..=4)
        || record_version == 0
        || !(16..=65_536).contains(&ciphertext.len())
    {
        return Err(ProtocolError::new("wrapper protocol fields are invalid"));
    }
    match kind {
        1 if parent_node_id.is_some()
            || generation_id.is_some()
            || share_id.is_some()
            || epoch.is_some() =>
        {
            return Err(ProtocolError::new("account-root wrapper scope is invalid"));
        }
        2 if parent_node_id.is_none()
            || generation_id.is_some()
            || share_id.is_some()
            || epoch.is_some() =>
        {
            return Err(ProtocolError::new("parent-node wrapper scope is invalid"));
        }
        3 if parent_node_id.is_some()
            || share_id.is_none()
            || epoch.is_none()
            || generation_id.is_none() =>
        {
            return Err(ProtocolError::new("share wrapper scope is invalid"));
        }
        4 if parent_node_id.is_some()
            || share_id.is_none()
            || epoch.is_none()
            || generation_id.is_some() =>
        {
            return Err(ProtocolError::new("share wrapper scope is invalid"));
        }
        _ => {}
    }

    Ok(WrapperRecord {
        format_version,
        wrapper_id,
        kind,
        node_id,
        parent_node_id,
        generation_id,
        share_id,
        epoch,
        record_version,
        ciphertext,
        aad_schema_id,
    })
}

pub fn decode_wrapper_material(canonical: Bytes) -> Result<DecodedWrapper, ProtocolError> {
    let record = decode_wrapper(&canonical)?;
    let hash = sha256(&canonical);
    Ok(DecodedWrapper {
        canonical,
        record,
        hash,
    })
}

pub fn decode_share_envelope(input: &[u8]) -> Result<ShareEnvelopeRecord, ProtocolError> {
    let mut reader = CborReader::new(input);
    let field_count = reader.read_map_len()?;
    reader.expect_key(1)?;
    let format_version = reader.read_uint()?;
    reader.expect_key(2)?;
    let suite_id = reader.read_uint()?;
    reader.expect_key(3)?;
    let envelope_id = reader.read_fixed_bytes::<16>()?;
    reader.expect_key(4)?;
    let share_id = reader.read_identifier()?;
    reader.expect_key(5)?;
    let epoch = reader.read_uint()?;
    reader.expect_key(6)?;
    let sender_id = reader.read_identifier()?;
    reader.expect_key(7)?;
    let sender_key_version = reader.read_uint()?;
    reader.expect_key(8)?;
    let recipient_id = reader.read_identifier()?;
    reader.expect_key(9)?;
    let recipient_key_version = reader.read_uint()?;
    reader.expect_key(10)?;
    let node_id = reader.read_identifier()?;
    reader.expect_key(11)?;
    let permissions = reader.read_uint()?;
    reader.expect_key(12)?;
    let generation_scope = reader.read_nullable_uint()?;
    reader.expect_key(13)?;
    let record_version = reader.read_uint()?;
    reader.expect_key(14)?;
    let previous_record_hash = reader.read_nullable_fixed_bytes::<32>()?;
    reader.expect_key(15)?;
    let encapsulated_key = reader.read_fixed_bytes::<32>()?;
    reader.expect_key(16)?;
    let ciphertext = reader.read_bytes(65_536)?;
    reader.expect_key(17)?;
    let aad_schema_id = reader.read_uint()?;
    reader.expect_key(18)?;
    let (wrapper_hashes, wrapper_set_root, wrapper_count) = match (format_version, field_count) {
        (FORMAT_VERSION, 18) => {
            let hashes = reader.read_fixed_bytes_array::<32>(MAX_WRAPPERS_PER_RECORD)?;
            let count = hashes.len() as u64;
            (hashes, None, count)
        }
        (SHARE_ENVELOPE_VERSION, 19) => {
            let root = reader.read_fixed_bytes::<32>()?;
            reader.expect_key(19)?;
            let count = reader.read_uint()?;
            (Vec::new(), Some(root), count)
        }
        _ => return Err(ProtocolError::new("share envelope version is unsupported")),
    };
    reader.finish()?;

    if suite_id != SUITE_ID
        || aad_schema_id != AAD_SCHEMA_ID
        || epoch == 0
        || sender_key_version == 0
        || recipient_key_version == 0
        || permissions != 1
        || record_version == 0
        || !(48..=65_536).contains(&ciphertext.len())
        || (record_version == 1) != previous_record_hash.is_none()
        || (format_version == FORMAT_VERSION && wrapper_hashes.is_empty())
        || (format_version == SHARE_ENVELOPE_VERSION
            && (wrapper_set_root.is_none()
                || wrapper_count == 0
                || wrapper_count > MAX_SHARE_WRAPPERS as u64))
    {
        return Err(ProtocolError::new("share envelope fields are invalid"));
    }

    Ok(ShareEnvelopeRecord {
        format_version,
        suite_id,
        envelope_id,
        share_id,
        epoch,
        sender_id,
        sender_key_version,
        recipient_id,
        recipient_key_version,
        node_id,
        permissions,
        generation_scope,
        record_version,
        previous_record_hash,
        encapsulated_key,
        ciphertext,
        aad_schema_id,
        wrapper_hashes,
        wrapper_set_root,
        wrapper_count,
    })
}

pub fn verify_share_envelope(
    canonical_cbor: &[u8],
    signature: &[u8],
    ed25519_public_key: &[u8],
) -> Result<(ShareEnvelopeRecord, [u8; 32]), ProtocolError> {
    let envelope = decode_share_envelope(canonical_cbor)?;
    let public_key: [u8; 32] = ed25519_public_key
        .try_into()
        .map_err(|_| ProtocolError::new("Ed25519 public key length is invalid"))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| ProtocolError::new("Ed25519 public key is invalid"))?;
    let signature = Signature::from_slice(signature)
        .map_err(|_| ProtocolError::new("Ed25519 signature length is invalid"))?;
    verifying_key
        .verify(canonical_cbor, &signature)
        .map_err(|_| ProtocolError::new("share envelope signature is invalid"))?;
    let mut signed_record = Vec::with_capacity(canonical_cbor.len() + 64);
    signed_record.extend_from_slice(canonical_cbor);
    signed_record.extend_from_slice(&signature.to_bytes());
    Ok((envelope, sha256(&signed_record)))
}

#[cfg(test)]
pub fn verify_node_record(
    bootstrap_cbor: &[u8],
    signature: &[u8],
    encrypted_manifest: &[u8],
    wrappers: &[DecodedWrapper],
    ed25519_public_key: &[u8],
) -> Result<VerifiedNodeRecord, ProtocolError> {
    let bootstrap = decode_bootstrap(bootstrap_cbor)?;
    verify_decoded_node_record(
        bootstrap_cbor,
        bootstrap,
        signature,
        encrypted_manifest,
        wrappers,
        ed25519_public_key,
    )
}

pub fn verify_decoded_node_record(
    bootstrap_cbor: &[u8],
    bootstrap: BootstrapRecord,
    signature: &[u8],
    encrypted_manifest: &[u8],
    wrappers: &[DecodedWrapper],
    ed25519_public_key: &[u8],
) -> Result<VerifiedNodeRecord, ProtocolError> {
    if encrypted_manifest.len() < 16 || encrypted_manifest.len() > 1_048_576 {
        return Err(ProtocolError::new("encrypted manifest length is invalid"));
    }
    if sha256(encrypted_manifest) != bootstrap.manifest_hash {
        return Err(ProtocolError::new("encrypted manifest commitment mismatch"));
    }
    if wrappers.len() != bootstrap.wrapper_ids.len()
        || wrappers.len() != bootstrap.wrapper_hashes.len()
    {
        return Err(ProtocolError::new("wrapper commitment count mismatch"));
    }

    for (index, wrapper) in wrappers.iter().enumerate() {
        if wrapper.record.wrapper_id != bootstrap.wrapper_ids[index]
            || wrapper.hash != bootstrap.wrapper_hashes[index]
            || wrapper.record.node_id != bootstrap.node_id
            || wrapper.record.record_version != bootstrap.record_version
        {
            return Err(ProtocolError::new("wrapper commitment mismatch"));
        }
    }

    let public_key: [u8; 32] = ed25519_public_key
        .try_into()
        .map_err(|_| ProtocolError::new("Ed25519 public key length is invalid"))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| ProtocolError::new("Ed25519 public key is invalid"))?;
    let signature = Signature::from_slice(signature)
        .map_err(|_| ProtocolError::new("Ed25519 signature length is invalid"))?;
    verifying_key
        .verify(bootstrap_cbor, &signature)
        .map_err(|_| ProtocolError::new("bootstrap signature is invalid"))?;

    let mut signed_record = Vec::with_capacity(bootstrap_cbor.len() + signature.to_bytes().len());
    signed_record.extend_from_slice(bootstrap_cbor);
    signed_record.extend_from_slice(&signature.to_bytes());

    Ok(VerifiedNodeRecord {
        bootstrap,
        record_hash: sha256(&signed_record),
    })
}

pub fn sha256(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

const WRAPPER_LEAF_DOMAIN: &[u8] = b"aeralyth/share-wrapper-leaf/v2";
const WRAPPER_BRANCH_DOMAIN: &[u8] = b"aeralyth/share-wrapper-branch/v2";
const WRAPPER_ROOT_DOMAIN: &[u8] = b"aeralyth/share-wrapper-root/v2";

pub fn wrapper_set_commitment(
    wrapper_hashes: &[[u8; 32]],
) -> Result<WrapperSetCommitment, ProtocolError> {
    if wrapper_hashes.is_empty() || wrapper_hashes.len() > MAX_SHARE_WRAPPERS {
        return Err(ProtocolError::new("share wrapper count is invalid"));
    }
    let mut ordered = wrapper_hashes.to_vec();
    ordered.sort_unstable();
    if ordered.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ProtocolError::new("share wrapper hash is duplicated"));
    }

    #[derive(Clone)]
    struct Node {
        hash: [u8; 32],
        start: usize,
        end: usize,
    }

    let mut proofs = vec![Vec::new(); ordered.len()];
    let mut level = ordered
        .iter()
        .enumerate()
        .map(|(index, hash)| {
            let mut input = Vec::with_capacity(WRAPPER_LEAF_DOMAIN.len() + hash.len());
            input.extend_from_slice(WRAPPER_LEAF_DOMAIN);
            input.extend_from_slice(hash);
            Node {
                hash: sha256(&input),
                start: index,
                end: index + 1,
            }
        })
        .collect::<Vec<_>>();

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let left = &pair[0];
            let right = pair.get(1).unwrap_or(left);
            for proof in &mut proofs[left.start..left.end] {
                proof.extend_from_slice(&right.hash);
            }
            if pair.len() == 2 {
                for proof in &mut proofs[right.start..right.end] {
                    proof.extend_from_slice(&left.hash);
                }
            }
            let mut input = Vec::with_capacity(WRAPPER_BRANCH_DOMAIN.len() + 64);
            input.extend_from_slice(WRAPPER_BRANCH_DOMAIN);
            input.extend_from_slice(&left.hash);
            input.extend_from_slice(&right.hash);
            next.push(Node {
                hash: sha256(&input),
                start: left.start,
                end: right.end,
            });
        }
        level = next;
    }

    let count = i32::try_from(ordered.len())
        .map_err(|_| ProtocolError::new("share wrapper count is invalid"))?;
    let mut root_input = Vec::with_capacity(WRAPPER_ROOT_DOMAIN.len() + 8 + 32);
    root_input.extend_from_slice(WRAPPER_ROOT_DOMAIN);
    root_input.extend_from_slice(&(ordered.len() as u64).to_be_bytes());
    root_input.extend_from_slice(&level[0].hash);
    let root = sha256(&root_input);
    let proofs = ordered
        .into_iter()
        .zip(proofs)
        .enumerate()
        .map(|(leaf_index, (wrapper_hash, proof))| WrapperSetProof {
            wrapper_hash,
            leaf_index: i32::try_from(leaf_index).unwrap_or(i32::MAX),
            proof,
        })
        .collect();

    Ok(WrapperSetCommitment {
        root,
        count,
        proofs,
    })
}

pub fn verify_wrapper_set_proof(
    wrapper_hash: [u8; 32],
    leaf_index: i32,
    proof: &[u8],
    wrapper_count: i32,
    expected_root: [u8; 32],
) -> bool {
    let Ok(mut index) = usize::try_from(leaf_index) else {
        return false;
    };
    let Ok(count) = usize::try_from(wrapper_count) else {
        return false;
    };
    if count == 0 || count > MAX_SHARE_WRAPPERS || index >= count {
        return false;
    }
    let depth = usize::BITS as usize - (count - 1).leading_zeros() as usize;
    if proof.len() != depth * 32 {
        return false;
    }

    let mut leaf_input = Vec::with_capacity(WRAPPER_LEAF_DOMAIN.len() + 32);
    leaf_input.extend_from_slice(WRAPPER_LEAF_DOMAIN);
    leaf_input.extend_from_slice(&wrapper_hash);
    let mut node = sha256(&leaf_input);
    for sibling in proof.chunks_exact(32) {
        let mut input = Vec::with_capacity(WRAPPER_BRANCH_DOMAIN.len() + 64);
        input.extend_from_slice(WRAPPER_BRANCH_DOMAIN);
        if index % 2 == 0 {
            input.extend_from_slice(&node);
            input.extend_from_slice(sibling);
        } else {
            input.extend_from_slice(sibling);
            input.extend_from_slice(&node);
        }
        node = sha256(&input);
        index /= 2;
    }
    let mut root_input = Vec::with_capacity(WRAPPER_ROOT_DOMAIN.len() + 8 + 32);
    root_input.extend_from_slice(WRAPPER_ROOT_DOMAIN);
    root_input.extend_from_slice(&(count as u64).to_be_bytes());
    root_input.extend_from_slice(&node);
    sha256(&root_input) == expected_root
}

pub fn verify_ed25519_signature(
    message: &[u8],
    signature: &[u8],
    ed25519_public_key: &[u8],
) -> Result<(), ProtocolError> {
    let public_key: [u8; 32] = ed25519_public_key
        .try_into()
        .map_err(|_| ProtocolError::new("Ed25519 public key length is invalid"))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| ProtocolError::new("Ed25519 public key is invalid"))?;
    let signature = Signature::from_slice(signature)
        .map_err(|_| ProtocolError::new("Ed25519 signature length is invalid"))?;
    verifying_key
        .verify(message, &signature)
        .map_err(|_| ProtocolError::new("Ed25519 signature is invalid"))
}

#[cfg(test)]
pub fn merkle_root(chunks: &[&[u8]]) -> [u8; 32] {
    if chunks.is_empty() {
        return sha256(&[]);
    }

    let mut level = chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let mut leaf = Vec::with_capacity(1 + 8 + chunk.len());
            leaf.push(0);
            leaf.extend_from_slice(&(index as u64).to_be_bytes());
            leaf.extend_from_slice(chunk);
            sha256(&leaf)
        })
        .collect::<Vec<_>>();

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            if pair.len() == 1 {
                next.push(pair[0]);
                continue;
            }
            let mut branch = Vec::with_capacity(65);
            branch.push(1);
            branch.extend_from_slice(&pair[0]);
            branch.extend_from_slice(&pair[1]);
            next.push(sha256(&branch));
        }
        level = next;
    }

    level[0]
}

fn validate_bootstrap(record: &BootstrapRecord) -> Result<(), ProtocolError> {
    if record.format_version != FORMAT_VERSION
        || record.suite_id != SUITE_ID
        || record.aad_schema_id != AAD_SCHEMA_ID
        || record.generation_number == 0
        || record.signer_key_version == 0
        || record.record_version == 0
        || record.ciphertext_length > MAX_CIPHERTEXT_BYTES
        || record.manifest_iv != [0_u8; 12]
        || record.wrapper_ids.is_empty()
        || record.wrapper_ids.len() != record.wrapper_hashes.len()
    {
        return Err(ProtocolError::new("bootstrap protocol fields are invalid"));
    }

    if (record.record_version == 1) != record.previous_record_hash.is_none() {
        return Err(ProtocolError::new("bootstrap record chain is invalid"));
    }

    Ok(())
}

struct CborReader<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> CborReader<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn finish(&self) -> Result<(), ProtocolError> {
        if self.offset == self.input.len() {
            Ok(())
        } else {
            Err(ProtocolError::new("CBOR record has trailing bytes"))
        }
    }

    fn expect_map_len(&mut self, expected: usize) -> Result<(), ProtocolError> {
        let actual = self.read_map_len()?;
        if actual == expected as u64 {
            Ok(())
        } else {
            Err(ProtocolError::new("CBOR map has an invalid field count"))
        }
    }

    fn read_map_len(&mut self) -> Result<u64, ProtocolError> {
        self.read_len(5)
    }

    fn expect_key(&mut self, expected: u64) -> Result<(), ProtocolError> {
        if self.read_uint()? == expected {
            Ok(())
        } else {
            Err(ProtocolError::new(
                "CBOR map keys are missing, duplicated, or out of order",
            ))
        }
    }

    fn read_uint(&mut self) -> Result<u64, ProtocolError> {
        self.read_len(0)
    }

    fn read_nullable_uint(&mut self) -> Result<Option<u64>, ProtocolError> {
        if self.peek()? == 0xf6 {
            self.offset += 1;
            Ok(None)
        } else {
            self.read_uint().map(Some)
        }
    }

    fn read_bytes(&mut self, maximum: usize) -> Result<Vec<u8>, ProtocolError> {
        let length = self.read_len(2)?;
        let length = usize::try_from(length)
            .map_err(|_| ProtocolError::new("CBOR byte string is too large"))?;
        if length > maximum {
            return Err(ProtocolError::new("CBOR byte string exceeds its limit"));
        }
        self.take(length).map(Vec::from)
    }

    fn read_fixed_bytes<const SIZE: usize>(&mut self) -> Result<[u8; SIZE], ProtocolError> {
        self.read_bytes(SIZE)?
            .try_into()
            .map_err(|_| ProtocolError::new("CBOR byte string has an invalid length"))
    }

    fn read_nullable_fixed_bytes<const SIZE: usize>(
        &mut self,
    ) -> Result<Option<[u8; SIZE]>, ProtocolError> {
        if self.peek()? == 0xf6 {
            self.offset += 1;
            Ok(None)
        } else {
            self.read_fixed_bytes::<SIZE>().map(Some)
        }
    }

    fn read_fixed_bytes_array<const SIZE: usize>(
        &mut self,
        maximum: usize,
    ) -> Result<Vec<[u8; SIZE]>, ProtocolError> {
        let length = self.read_len(4)?;
        let length =
            usize::try_from(length).map_err(|_| ProtocolError::new("CBOR array is too large"))?;
        if length > maximum {
            return Err(ProtocolError::new("CBOR array exceeds its limit"));
        }

        (0..length)
            .map(|_| self.read_fixed_bytes::<SIZE>())
            .collect()
    }

    fn read_identifier(&mut self) -> Result<String, ProtocolError> {
        let length = self.read_len(3)?;
        let length = usize::try_from(length)
            .map_err(|_| ProtocolError::new("CBOR text string is too large"))?;
        if length > 128 {
            return Err(ProtocolError::new("CBOR text string exceeds its limit"));
        }
        let value = self.take(length)?.to_vec();
        if value.len() < 3
            || !value
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(ProtocolError::new("CBOR identifier is invalid"));
        }
        String::from_utf8(value).map_err(|_| ProtocolError::new("CBOR identifier is not UTF-8"))
    }

    fn read_nullable_identifier(&mut self) -> Result<Option<String>, ProtocolError> {
        if self.peek()? == 0xf6 {
            self.offset += 1;
            Ok(None)
        } else {
            self.read_identifier().map(Some)
        }
    }

    fn read_len(&mut self, expected_major: u8) -> Result<u64, ProtocolError> {
        let first = self.read_byte()?;
        let major = first >> 5;
        let additional = first & 0x1f;
        if major != expected_major {
            return Err(ProtocolError::new("CBOR value has an invalid type"));
        }

        match additional {
            value @ 0..=23 => Ok(u64::from(value)),
            24 => {
                let value = u64::from(self.read_byte()?);
                if value < 24 {
                    Err(ProtocolError::new("CBOR integer is not minimally encoded"))
                } else {
                    Ok(value)
                }
            }
            25 => {
                let value = u64::from(u16::from_be_bytes(self.take(2)?.try_into().unwrap()));
                if value <= u64::from(u8::MAX) {
                    Err(ProtocolError::new("CBOR integer is not minimally encoded"))
                } else {
                    Ok(value)
                }
            }
            26 => {
                let value = u64::from(u32::from_be_bytes(self.take(4)?.try_into().unwrap()));
                if value <= u64::from(u16::MAX) {
                    Err(ProtocolError::new("CBOR integer is not minimally encoded"))
                } else {
                    Ok(value)
                }
            }
            27 => {
                let value = u64::from_be_bytes(self.take(8)?.try_into().unwrap());
                if value <= u64::from(u32::MAX) {
                    Err(ProtocolError::new("CBOR integer is not minimally encoded"))
                } else {
                    Ok(value)
                }
            }
            _ => Err(ProtocolError::new(
                "indefinite-length or reserved CBOR values are forbidden",
            )),
        }
    }

    fn peek(&self) -> Result<u8, ProtocolError> {
        self.input
            .get(self.offset)
            .copied()
            .ok_or_else(|| ProtocolError::new("CBOR record ended unexpectedly"))
    }

    fn read_byte(&mut self) -> Result<u8, ProtocolError> {
        let byte = self.peek()?;
        self.offset += 1;
        Ok(byte)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.input.len())
            .ok_or_else(|| ProtocolError::new("CBOR record ended unexpectedly"))?;
        let value = &self.input[self.offset..end];
        self.offset = end;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    #[test]
    fn vault_multipart_upload_requires_more_than_one_full_part() {
        assert!(!uses_vault_multipart_upload(UPLOAD_PART_BYTES - 1));
        assert!(!uses_vault_multipart_upload(UPLOAD_PART_BYTES));
        assert!(uses_vault_multipart_upload(UPLOAD_PART_BYTES + 1));
    }

    #[test]
    fn merkle_tree_promotes_an_unpaired_hash() {
        let chunks = [b"one".as_slice(), b"two".as_slice(), b"three".as_slice()];
        let root = merkle_root(&chunks);
        assert_ne!(root, sha256(&[]));
        assert_eq!(root, merkle_root(&chunks));
    }

    #[test]
    fn rejects_non_minimal_map_length() {
        let input = [0xb8, 0x0f];
        let error = decode_bootstrap(&input).unwrap_err();
        assert!(error.to_string().contains("minimally"));
    }

    #[test]
    fn decodes_the_browser_canonical_bootstrap_vector() {
        let input = decode_hex(
            "af010102010301046b66696c5f746573743132330501065001010101010101010101010101010101074c00000000000000000000000008815002020202020202020202020202020202091910100a010b010cf60d582003030303030303030303030303030303030303030303030303030303030303030e81582004040404040404040404040404040404040404040404040404040404040404040f58200505050505050505050505050505050505050505050505050505050505050505",
        );
        let decoded = decode_bootstrap(&input).unwrap();
        assert_eq!(decoded.node_id, "fil_test123");
        assert_eq!(decoded.ciphertext_length, 4_112);
        assert_eq!(decoded.generation_id, [1_u8; 16]);
        assert_eq!(decoded.wrapper_hashes, vec![[4_u8; 32]]);
    }

    #[test]
    fn verifies_signature_and_commitments() {
        reset_wrapper_decode_calls();
        let wrapper = encode_wrapper_for_test();
        let wrapper_hash = sha256(&wrapper);
        let manifest = b"encrypted-manifest-with-tag";
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let bootstrap = encode_bootstrap_for_test(sha256(manifest), wrapper_hash);
        let signature = signing_key.sign(&bootstrap).to_bytes();
        let decoded_wrapper = decode_wrapper_material(Bytes::from(wrapper)).unwrap();
        let verified = verify_node_record(
            &bootstrap,
            &signature,
            manifest,
            std::slice::from_ref(&decoded_wrapper),
            &signing_key.verifying_key().to_bytes(),
        )
        .unwrap();

        assert_eq!(verified.bootstrap.node_id, "fil_test");
        assert_eq!(verified.bootstrap.record_version, 1);
        assert_eq!(wrapper_decode_calls(), 1);

        let mut tampered_manifest = manifest.to_vec();
        tampered_manifest[0] ^= 1;
        let error = verify_node_record(
            &bootstrap,
            &signature,
            &tampered_manifest,
            std::slice::from_ref(&decoded_wrapper),
            &signing_key.verifying_key().to_bytes(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("manifest commitment"));
        assert_eq!(wrapper_decode_calls(), 1);

        let mut tampered_signature = signature;
        tampered_signature[0] ^= 1;
        let error = verify_node_record(
            &bootstrap,
            &tampered_signature,
            manifest,
            std::slice::from_ref(&decoded_wrapper),
            &signing_key.verifying_key().to_bytes(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("signature"));
        assert_eq!(wrapper_decode_calls(), 1);
    }

    #[test]
    fn wrapper_set_commitment_proofs_cover_every_sorted_leaf() {
        let hashes = [[3_u8; 32], [1_u8; 32], [2_u8; 32]];
        let commitment = wrapper_set_commitment(&hashes).unwrap();

        assert_eq!(commitment.count, 3);
        assert_eq!(
            commitment.root.as_slice(),
            decode_hex("e3204f260c1b5a7ac452b00bf91a562062bdbff758ed8e6386e732f63bee709b")
        );
        assert_eq!(commitment.proofs.len(), 3);
        assert_eq!(
            commitment.proofs[0].proof,
            decode_hex(
                "c635a2f3548516774fe0d5d4e652f36ab67baebf95b29110032e50d0276293368adc76e8e70bb7eb0278ae2f5dab61b0509ae2fa5f62b179b117381304185af3"
            )
        );
        for proof in &commitment.proofs {
            assert!(verify_wrapper_set_proof(
                proof.wrapper_hash,
                proof.leaf_index,
                &proof.proof,
                commitment.count,
                commitment.root,
            ));
        }

        let mut tampered = commitment.proofs[0].proof.clone();
        tampered[0] ^= 1;
        assert!(!verify_wrapper_set_proof(
            commitment.proofs[0].wrapper_hash,
            commitment.proofs[0].leaf_index,
            &tampered,
            commitment.count,
            commitment.root,
        ));
    }

    #[test]
    fn decodes_a_constant_size_protocol_v2_share_envelope() {
        let commitment = wrapper_set_commitment(&[[7_u8; 32]]).unwrap();
        let input = encode_share_envelope_v2_for_test(commitment.root, commitment.count as u8);
        let decoded = decode_share_envelope(&input).unwrap();

        assert_eq!(decoded.format_version, SHARE_ENVELOPE_VERSION);
        assert_eq!(decoded.wrapper_set_root, Some(commitment.root));
        assert_eq!(decoded.wrapper_count, 1);
        assert!(decoded.wrapper_hashes.is_empty());
        assert!(input.len() < 300);
    }

    #[test]
    fn decodes_the_browser_share_directory_vector() {
        let input = decode_hex(
            "ab010102010301046b66696c5f7465737431323305020658200303030303030303030303030303030303030303030303030303030303030303070408500505050505050505050505050505050509060a582007070707070707070707070707070707070707070707070707070707070707070b1864",
        );
        let directory = decode_share_directory(&input).unwrap();

        assert_eq!(directory.node_id, "fil_test123");
        assert_eq!(directory.record_version, 2);
        assert_eq!(directory.generation_number, 4);
        assert_eq!(directory.wrapper_count, 100);
        assert_eq!(directory.record_hash, [3_u8; 32]);
        assert_eq!(directory.wrapper_set_root, [7_u8; 32]);
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    fn encode_bootstrap_for_test(manifest_hash: [u8; 32], wrapper_hash: [u8; 32]) -> Vec<u8> {
        let mut output = vec![0xaf];
        push_uint_pair(&mut output, 1, 1);
        push_uint_pair(&mut output, 2, 1);
        push_uint_pair(&mut output, 3, 1);
        push_key(&mut output, 4);
        push_text(&mut output, b"fil_test");
        push_uint_pair(&mut output, 5, 1);
        push_key(&mut output, 6);
        push_bytes(&mut output, &[3_u8; 16]);
        push_key(&mut output, 7);
        push_bytes(&mut output, &[0_u8; 12]);
        push_key(&mut output, 8);
        output.push(0x81);
        push_bytes(&mut output, &[4_u8; 16]);
        push_uint_pair(&mut output, 9, 25);
        push_uint_pair(&mut output, 10, 1);
        push_uint_pair(&mut output, 11, 1);
        push_key(&mut output, 12);
        output.push(0xf6);
        push_key(&mut output, 13);
        push_bytes(&mut output, &manifest_hash);
        push_key(&mut output, 14);
        output.push(0x81);
        push_bytes(&mut output, &wrapper_hash);
        push_key(&mut output, 15);
        push_bytes(&mut output, &[5_u8; 32]);
        output
    }

    fn encode_wrapper_for_test() -> Vec<u8> {
        let mut output = vec![0xab];
        push_uint_pair(&mut output, 1, 1);
        push_key(&mut output, 2);
        push_bytes(&mut output, &[4_u8; 16]);
        push_uint_pair(&mut output, 3, 1);
        push_key(&mut output, 4);
        push_text(&mut output, b"fil_test");
        for key in [5_u8, 6, 7, 8] {
            push_key(&mut output, key);
            output.push(0xf6);
        }
        push_uint_pair(&mut output, 9, 1);
        push_key(&mut output, 10);
        push_bytes(&mut output, &[9_u8; 48]);
        push_uint_pair(&mut output, 11, 1);
        output
    }

    fn encode_share_envelope_v2_for_test(root: [u8; 32], wrapper_count: u8) -> Vec<u8> {
        let mut output = vec![0xb3];
        push_uint_pair(&mut output, 1, SHARE_ENVELOPE_VERSION as u8);
        push_uint_pair(&mut output, 2, SUITE_ID as u8);
        push_key(&mut output, 3);
        push_bytes(&mut output, &[10_u8; 16]);
        push_key(&mut output, 4);
        push_text(&mut output, b"shr_test");
        push_uint_pair(&mut output, 5, 1);
        push_key(&mut output, 6);
        push_text(&mut output, b"usr_sender");
        push_uint_pair(&mut output, 7, 1);
        push_key(&mut output, 8);
        push_text(&mut output, b"usr_recipient");
        push_uint_pair(&mut output, 9, 1);
        push_key(&mut output, 10);
        push_text(&mut output, b"fil_test");
        push_uint_pair(&mut output, 11, 1);
        push_key(&mut output, 12);
        output.push(0xf6);
        push_uint_pair(&mut output, 13, 1);
        push_key(&mut output, 14);
        output.push(0xf6);
        push_key(&mut output, 15);
        push_bytes(&mut output, &[12_u8; 32]);
        push_key(&mut output, 16);
        push_bytes(&mut output, &[13_u8; 48]);
        push_uint_pair(&mut output, 17, AAD_SCHEMA_ID as u8);
        push_key(&mut output, 18);
        push_bytes(&mut output, &root);
        push_uint_pair(&mut output, 19, wrapper_count);
        output
    }

    fn push_uint_pair(output: &mut Vec<u8>, key: u8, value: u8) {
        push_key(output, key);
        push_uint(output, value);
    }

    fn push_key(output: &mut Vec<u8>, key: u8) {
        push_uint(output, key);
    }

    fn push_uint(output: &mut Vec<u8>, value: u8) {
        if value < 24 {
            output.push(value);
        } else {
            output.extend_from_slice(&[0x18, value]);
        }
    }

    fn push_bytes(output: &mut Vec<u8>, value: &[u8]) {
        if value.len() < 24 {
            output.push(0x40 | value.len() as u8);
        } else {
            output.extend_from_slice(&[0x58, value.len() as u8]);
        }
        output.extend_from_slice(value);
    }

    fn push_text(output: &mut Vec<u8>, value: &[u8]) {
        if value.len() < 24 {
            output.push(0x60 | value.len() as u8);
        } else {
            output.extend_from_slice(&[0x78, value.len() as u8]);
        }
        output.extend_from_slice(value);
    }
}
