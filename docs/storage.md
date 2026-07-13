# Object storage

Aeralyth uses local asynchronous file storage in development and a private
S3-compatible bucket in production. Metadata, quota reservations, counters,
and deletion jobs stay in PostgreSQL. Object bytes travel directly between the
browser and S3 through short-lived presigned URLs.

## Local development

Keep `AERALYTH_STORAGE_BACKEND=local`. Objects are written below
`AERALYTH_STORAGE_PATH`; the same upload control API is used, but the PUT body
is sent to the Actix development endpoint.

## Railway production

Set `AERALYTH_ENV=production` and `AERALYTH_STORAGE_BACKEND=s3`, then provide `BUCKET`, `ENDPOINT`, `REGION`,
`ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` from a private Railway storage bucket.
The equivalent `AERALYTH_S3_*` and standard AWS variable names are also
accepted. Keep the API and bucket in the same Railway region.

Railway is detected as production automatically. The API refuses to start with
local storage or incomplete bucket credentials in that environment; it never
falls back to an ephemeral service filesystem.

Configure bucket CORS for the exact frontend origin. Permit `PUT`, permit the
`content-type` and `x-amz-checksum-sha256` request headers, and expose `ETag`
and `x-amz-checksum-sha256`. Do not use a wildcard origin in production.

Railway Storage Buckets do not currently expose lifecycle configuration for
aborting incomplete multipart uploads. Aeralyth therefore writes a durable
`initializing` intent before calling S3 and runs an hourly `ListMultipartUploads`
reconciliation under a PostgreSQL advisory lock. Unknown `users/` uploads older
than `AERALYTH_MULTIPART_ORPHAN_GRACE_SECONDS` are aborted. Known cancellations
and expirations remain in the database-backed deletion queue until both the
multipart abort and object deletion succeed.

Legacy development objects remain readable from
`AERALYTH_STORAGE_PATH/<owner>/<storage-name>` on the original host. Before an
existing installation switches to replicated production services, copy those
objects into the bucket and rewrite their `files.storage_name` values to the
new object keys. Do not depend on the legacy filesystem fallback in Railway.

The initial defaults are a 100 MiB multipart threshold, 64 MiB parts, four
concurrent browser part uploads, a 15-minute signature lifetime, a one-hour
orphan grace period, and a 10 GiB per-user quota. Presigned PUTs bind the exact
reserved object or part length; the browser verifies that length before sending
the Blob and the user agent supplies the corresponding `Content-Length`.
Multipart part sizes are stored with each upload so resumptions remain valid
across configuration changes. Single-object deletion is deferred until every
issued PUT signature has expired, preventing a late write from recreating a
cleaned-up key. Tune these values from production measurements rather than
increasing them globally.
