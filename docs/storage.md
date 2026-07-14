# Object storage

Aeralyth uses a private S3-compatible bucket for encrypted vault data in both
development and production. Metadata, quota reservations, counters, and
deletion jobs stay in PostgreSQL. Encrypted object bytes travel directly between
the browser and S3 through short-lived presigned URLs.

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
