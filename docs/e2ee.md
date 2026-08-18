# Encrypted vault

Aeralyth vault format 1 encrypts file content and private file metadata in a
dedicated browser worker before object bytes leave the device. PostgreSQL and
S3 store ciphertext, signed public bootstrap records, opaque key wrappers, and
the minimum routing metadata needed to operate the service.

## Security boundary

The encrypted vault protects file content, names, MIME types, plaintext sizes,
and timestamps against an honest-but-curious storage service and against an
offline database or bucket disclosure. Signed bootstrap records, wrapper
commitments, authenticated encryption, Merkle roots, monotonic record versions,
previous-record hashes, and compare-and-swap heads reject modified or stale
writes.

The service still observes account identity and role, session activity, file or
folder type, parent/child topology, share participants and permissions, trash
state, padded ciphertext sizes, and request timing. PADME reduces exact size
leakage; it does not hide whether an entry is a file or folder.

The design does not protect a device after malicious code executes in the
signed-in Aeralyth origin, a stolen vault password or recovery key, plaintext a
recipient already downloaded, traffic analysis, or service denial and deletion.
A fully malicious server can replay a self-consistent historical snapshot to a
fresh client that has no separately pinned head or transparency log. Browser
JavaScript and WASM can only overwrite temporary buffers on a best-effort basis;
complete memory erasure is not guaranteed.

## Cryptographic suite

- Account root: random 32-byte material, wrapped at rest and imported after
  unlock as a non-extractable Web Crypto HKDF key.
- Password KDF: libsodium Argon2id13 with exactly 3 operations, 268435456 bytes
  of memory, a 16-byte salt, and a 32-byte output. A real 256 MiB preflight runs
  before setup. Unsupported devices are rejected; parameters are never lowered.
- Recovery: random 256-bit Base58Check key. Recovery rotates both password and
  recovery wrappers and displays the replacement recovery key once.
- Node keys: random 256-bit key material wrapped by the account root for a root
  node or by the parent node key for a child.
- Content: one AES-256-GCM key per object generation, derived with HKDF-SHA-256
  from the node key and a unique random 128-bit generation ID.
- Chunks: 4 MiB authenticated-encryption chunks with a deterministic 96-bit
  big-endian chunk counter IV. Every chunk authenticates node, generation,
  chunk index, and padded plaintext length as AAD.
- Metadata and wrappers: a separate derived key for every record and a zero IV.
  Key separation and a unique record ID/version make the IV unique per key.
- Serialization: RFC 8949 core deterministic CBOR, fixed integer field keys,
  minimal integers, definite lengths only, and no floats or alternate forms.
- Signatures: Ed25519 signatures cover canonical bootstrap and authenticated
  HPKE envelope records. Bootstraps commit the encrypted manifest hash, wrapper
  IDs and hashes, ciphertext Merkle root, suite, AAD schema, generation, record
  version, and previous record hash.
- Sharing: authenticated HPKE using X25519, HKDF-SHA-256, and AES-256-GCM. The
  sender signs the canonical `(enc, ciphertext)` envelope and its full scope.
  Share-envelope protocol 2 commits the epoch's wrapper set once with a
  domain-separated Merkle root and wrapper count. Recipient envelopes contain
  only that constant-size commitment. Downloads carry proofs for the one or two
  wrappers they need; wrappers added by later node records remain committed by
  the signed node bootstrap. Protocol-1 envelopes remain readable during the
  migration but are never emitted for new shares or epoch rotations.

## Recovery and locking

The normal account password cannot unlock file data. Each user chooses a
separate vault password and receives a one-time recovery key. Losing both makes
the encrypted data permanently unrecoverable; administrators cannot reset the
vault.

The active account root and identity private keys live in the dedicated
same-origin worker. While the vault is unlocked, IndexedDB may hold an expiring
clone of the non-extractable account-root `CryptoKey`; a random marker scoped to
the current tab and bound to the authenticated server session makes that key
reachable after a refresh. Identity private-key bytes are decrypted again inside
the new worker and are never written to browser storage as plaintext.

Activity renews the configured 5, 15, 30, or 60 minute deadline. Refreshing the
same tab resumes the vault only while that deadline and tab marker remain valid.
Explicit locking, signing out, an expired deadline, or losing the tab session
prevents restoration. Locking drops in-memory `CryptoKey` references, deletes
the active resume record, and best-effort overwrites temporary byte arrays.

## Sharing and revocation

A share has a random epoch key. Recipients receive that epoch key through an
authenticated HPKE envelope; they never receive account or node keys. Every
node in the shared subtree has a metadata-key wrapper, and each current file
generation has a content-key wrapper.

Revocation creates a pending epoch, fences publication under the old epoch,
captures the complete subtree head snapshot, creates all replacement wrappers
and retained-recipient envelopes, and atomically publishes the epoch and cutoff.
This prevents a revoked recipient from deriving future metadata or content.
Revocation cannot erase old ciphertext, plaintext, or keys already copied by a
recipient.

The server validates the complete wrapper set and Merkle root once when an
epoch is published, then persists each initial wrapper's leaf index and compact
proof. Adding recipients therefore no longer duplicates the full wrapper-hash
array in every signed HPKE envelope, and per-node download metadata grows with
the proof depth instead of the subtree size.

## Storage and uploads

Encrypted bytes are uploaded directly to private S3-compatible storage through
short-lived URLs signed by the Actix API. Browser code never receives long-lived
bucket credentials. Cryptographic chunks remain 4 MiB, while multipart upload
parts aggregate them into fixed 32 MiB parts. Standard S3 checksums protect each
PUT and the browser verifies the signed length before sending it.

Quota reservation is serialized per user in PostgreSQL and includes committed
objects plus legacy and encrypted uploads in progress. Migration receives credit
for the plaintext object being replaced so temporary ciphertext does not create
a false quota failure.

## Vault publication wire format

The first-party browser sends large node and share publications as
`application/vnd.aeralyth.vault-publication`. Authentication, CSRF validation,
the 8 MiB request limit, and bounded validation admission are applied before the
payload is trusted. JSON/base64 remains a compatibility reader for older clients;
new browser publications do not select it.

Wire version 1 is length-delimited and network-byte-order encoded. Every message
starts with the eight-byte header `AVLT`, version `1`, a one-byte message kind,
and two zero reserved bytes. Kinds `1` through `4` represent node publication,
share-directory publication, share creation, and epoch publication. Byte strings,
UTF-8 strings, and array counts use unsigned 32-bit length prefixes; unsigned
64-bit values are big-endian. Optional byte strings use `0xffffffff` for null.
Decoders reject unknown headers, invalid UTF-8, oversized counts or fields,
truncated data, and trailing bytes.

The browser encoder measures the complete message and allocates one output
buffer. The API collects one bounded request buffer and exposes cryptographic
fields as shared `Bytes` slices into it, so validation does not first expand or
copy them through base64 strings. Binary parsing and compatibility JSON
deserialization/base64 conversion, Ed25519 verification, deterministic-CBOR
decoding, hashing, sorting, and large JSON response encoding run through the
bounded vault-validation service rather than Actix's async workers. Request
database leases are returned before that CPU work or S3 URL signing begins;
subtree snapshot rows retain deterministic traversal order in PostgreSQL so no
large in-handler sort extends a transaction.

## Railway S3 setup

Use a private Railway Storage Bucket in development and production. Configure
bucket CORS for each exact frontend origin:

- Methods: `GET`, `HEAD`, `PUT`
- Request headers: `content-type`, `range`, `x-amz-checksum-sha256`
- Exposed headers: `ETag`, `Content-Length`, `Content-Range`,
  `x-amz-checksum-sha256`
- Production origin: never `*`

The repository includes `docs/railway-s3-cors.local.json` for local
development. Apply it with the command in `docs/storage.md`. Production must
use a separate policy containing the deployed frontend's exact HTTPS origin.

Set the API environment:

```text
AERALYTH_STORAGE_BACKEND=s3
AWS_ENDPOINT_URL=https://<bucket-endpoint>
AWS_ACCESS_KEY_ID=<bucket-access-key>
AWS_SECRET_ACCESS_KEY=<bucket-secret>
AWS_S3_BUCKET_NAME=<bucket-name>
AWS_DEFAULT_REGION=<bucket-region>
AWS_S3_URL_STYLE=virtual
AERALYTH_E2EE_MODE=migrate
```

Set `AERALYTH_S3_CSP_ORIGIN` on the Next.js service to the exact origin of
presigned bucket URLs. The frontend applies a nonce-based Content Security
Policy, same-origin worker policy, and a narrowly scoped storage connection
origin. Development permits inline styles because the Next.js development
runtime injects them; production style elements remain nonce-restricted.

`require-trusted-types-for 'script'` is not enabled. Next.js 16's React and
Turbopack runtimes currently assign script URLs and HTML through string-based
DOM sinks, so enforcing Trusted Types prevents hydration. A permissive default
policy would restore rendering but would not provide a meaningful security
boundary. The nonce-based `script-src` policy remains enforced instead.

## Rollout and migration

1. Back up PostgreSQL and all legacy objects. Keep
   `AERALYTH_E2EE_MODE=off` while applying `database/init/002_e2ee.sql`.
2. Configure the private S3 bucket, CORS, CSP origin, and credentials on both
   frontend and API services.
3. Set `AERALYTH_E2EE_MODE=migrate`. Plaintext uploads and legacy sharing are
   disabled immediately. Users create their vault and run migration in Settings.
4. Migration claims nodes top-down. The browser streams each legacy object,
   encrypts it locally, verifies upload checksums and signed commitments, and
   publishes the new generation in one database transaction. Only then is the
   legacy object queued for durable deletion.
5. Interrupted migrations are reclaimable. Pending multipart uploads are
   aborted and deletion jobs retry until storage confirms cleanup.
6. Wait until `/api/vault` reports `readyForRequired: true` for every account.
   Also verify no legacy nodes or incomplete migration jobs remain.
7. Set `AERALYTH_E2EE_MODE=required` and restart the API. Startup refuses this
   mode while any plaintext or incomplete migration state exists.

Useful database checks:

```sql
SELECT e2ee_state, count(*) FROM files GROUP BY e2ee_state;
SELECT state, count(*) FROM vault_migrations GROUP BY state;
SELECT status, count(*) FROM vault_uploads GROUP BY status;
```

If rollout must pause, return to `migrate`; already encrypted objects remain
encrypted. Do not return to plaintext uploads after users have begun relying on
the encrypted vault.
