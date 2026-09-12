# Object storage

Aeralyth uses a private S3-compatible bucket for encrypted vault data in both
development and production. Metadata, quota reservations, counters, and
deletion jobs stay in PostgreSQL. Encrypted object bytes travel directly between
the browser and S3 through short-lived presigned URLs.

## Storage overview

The administrator Storage page separates the signed-in account's usage and
quota from the whole bucket. Account usage comes from the existing PostgreSQL
counters, including Trash; `AERALYTH_STORAGE_QUOTA_BYTES` remains the per-account
upload limit. Percentages show one decimal place. Displayed byte sizes use
decimal units, matching Railway: the default 10 GiB quota is shown as 10.7 GB.

`GET /api/admin/storage` requires an administrator session and returns the
account summary plus aggregate S3 bucket measurements. It does not load file
listings or decrypted metadata. The bucket totals count all completed objects
through paginated `ListObjectsV2` requests, including objects from other accounts;
in-progress multipart uploads and non-current object versions are not included.
The account quota is not a bucket capacity limit.

The first bucket measurement runs in the background. PostgreSQL stores a shared
complete snapshot and a separate resumable scan checkpoint. One fenced worker
refreshes the snapshot on demand after 15 minutes; other replicas reuse that
work. Each chunk has a 10-second scheduling budget and at most 20 pages. A page
has a 30-second timeout, and successful pages are spaced by 500 milliseconds.
Failures retain committed progress and the last complete measurement. Partial
totals are never published. The timestamp is the start of the completed scan,
so interrupted or long scans show their actual age. Bucket name and region come
from the configured S3 connection; credentials and object keys are never
returned to the browser.

Local-filesystem development continues to report local storage and has no
bucket totals. Production uses its configured Railway S3 bucket. Run the
snapshot regressions with `cargo test --manifest-path backend/Cargo.toml
bucket_usage::tests`. To include lease, failover and checkpoint tests, set
`AERALYTH_DATABASE_INTEGRATION_TESTS=1` and point `DATABASE_URL` at an isolated
test database with migration 032 applied. Provider tests use a loopback S3 stub;
they do not access a production bucket.

## Local development

Use Railway S3 locally with `AERALYTH_STORAGE_BACKEND=s3`. The API accepts the
same bucket variables as production and issues presigned URLs to the browser.
Set bucket CORS for the exact local frontend origin and set
`AERALYTH_S3_CSP_ORIGIN` to the presigned URL origin.

Apply the checked-in development policy with the standard AWS CLI after loading
the bucket credentials into the current shell:

```sh
aws s3api put-bucket-cors \
  --bucket "$AWS_S3_BUCKET_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --region "$AWS_DEFAULT_REGION" \
  --cors-configuration file://docs/railway-s3-cors.local.json
```

This policy allows only `http://localhost:3000` and
`http://127.0.0.1:3000`. Create a separate production policy containing the
deployed frontend's exact HTTPS origin; do not add a wildcard origin to the
development policy.

The local filesystem backend remains available only while
`AERALYTH_E2EE_MODE=off` so old installations can be migrated. The API refuses
`migrate` or `required` mode unless S3 is configured.

Authenticated local downloads support a single byte range, exact `206` and
`416` responses, and strong `ETag`/`If-Range` validation. The validator includes
the storage identity and opened file metadata so replacing an object causes a
full response instead of appending changed content to a prior download. The
private `no-store, no-transform` policy keeps the reverse proxy from changing
partial bytes or validators.

## Railway production

Set `AERALYTH_ENV=production` and `AERALYTH_STORAGE_BACKEND=s3`, then provide `BUCKET`, `ENDPOINT`, `REGION`,
`ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` from a private Railway storage bucket.
The equivalent `AERALYTH_S3_*` and standard AWS variable names are also
accepted. Keep the API and bucket in the same Railway region.

Set a stable `AERALYTH_SHARE_LINK_SECRET` generated with
`openssl rand -base64 32`. It is used only to reconstruct owner-visible share
URLs; raw bearer tokens are never stored in PostgreSQL.

Railway is detected as production automatically. The API refuses to start with
local storage or incomplete bucket credentials in that environment; it never
falls back to an ephemeral service filesystem.

Configure bucket CORS for the exact frontend origin. Permit `GET`, `HEAD` and
`PUT`, permit the `content-type`, `range` and `x-amz-checksum-sha256` request
headers, and expose `ETag`, `Content-Range`, `Content-Length` and
`x-amz-checksum-sha256`. The checked-in CORS policies contain these headers.
Do not use a wildcard origin in production.

Railway Storage Buckets do not currently expose lifecycle configuration for
aborting incomplete multipart uploads. Aeralyth therefore writes a durable
`initializing` intent before calling S3 and starts an hourly `ListMultipartUploads`
reconciliation with a durable, fenced lease and pagination cursor. Unknown `users/` uploads older
than `AERALYTH_MULTIPART_ORPHAN_GRACE_SECONDS` are aborted only after the
reconciler has checked both `file_uploads` and `vault_uploads` by object key and
provider upload ID. A live intent protects a mismatched provider entry until its
write/intent TTL has elapsed, and an initializing intent can adopt its provider
ID only inside its existing `users/<id>/files/` or `users/<id>/vault/`
namespace. Each group of at most 64 candidates adopts live intents and performs
the final eligibility check in one database call. True orphans enter a durable
abort queue whose fence prevents a late writer from adopting an upload while
its provider abort is pending. Existing upload row locks precede object advisory
locks so this transition cannot deadlock an initializer. A worker restart resumes
the stored cursor and pending aborts. Provider waits never retain a maintenance
database connection. Known cancellations
and expirations remain in the database-backed deletion queue until both the
multipart abort and object deletion succeed.

`AERALYTH_STORAGE_MAINTENANCE_CONCURRENCY` caps actual maintenance provider
operations across all workers and overview scans in one API process. Each
listing, HEAD, delete or abort acquires one permit immediately around its I/O;
exact-key multipart discovery does not hold an outer permit while its nested
aborts run. Interactive storage operations retain their separate admission
capacity. The metrics `aeralyth_maintenance_provider_in_flight` and
`aeralyth_maintenance_provider_peak` expose current and peak admitted work.

Administrative user deletion is asynchronous. The request transaction changes
the account to `deleting`, revokes its sessions, and creates one durable
`user_deletion_jobs` checkpoint. The maintenance worker then queues legacy,
active upload, encrypted generation, and migration object keys before removing
metadata in 500-row, retryable phases. It deletes file trees leaf-first and
removes the user row only after a final user-row lock proves that no in-flight
request introduced another object. The final lock either restarts the sweep or
fences new foreign-key inserts until deletion commits. This keeps the API
response and every worker transaction bounded while preserving every object in
the durable storage-deletion queue.

Legacy development objects remain readable during migration from
`AERALYTH_STORAGE_PATH/<owner>/<storage-name>` on the original host. Before an
existing installation switches to replicated production services, copy those
objects into the bucket and rewrite their `files.storage_name` values to the
new object keys. Do not depend on the legacy filesystem fallback in Railway.

The legacy upload defaults are a 100 MiB multipart threshold and 64 MiB parts.
Encrypted vault uploads use fixed 32 MiB multipart parts over 4 MiB
authenticated-encryption chunks. Other defaults include four
concurrent browser part uploads, a 15-minute signature lifetime, a one-hour
orphan grace period, and a 10 GiB per-user quota. Presigned PUTs bind the exact
reserved object or part length; the browser verifies that length before sending
the Blob and the user agent supplies the corresponding `Content-Length`.
Multipart part sizes are stored with each upload so resumptions remain valid
across configuration changes. Single-object deletion is deferred until every
issued PUT signature has expired, preventing a late write from recreating a
cleaned-up key. Tune these values from production measurements rather than
increasing them globally.

See [Encrypted vault](./e2ee.md) for the cryptographic design, CORS contract,
and staged migration runbook.
