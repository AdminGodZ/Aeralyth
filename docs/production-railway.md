# Aeralyth production on Railway

Aeralyth runs as one public Railway web service. Inside that service, Caddy
routes `/api/*`, `/health`, and `/metrics` directly to Actix on port 8081 and
routes all other requests to the standalone Next.js server on port 3000. Only
Caddy listens on Railway's public `PORT`; startup automatically moves either
internal listener if a custom public port would otherwise collide.

PostgreSQL and `aeralyth-storage-prod` remain separate private Railway
resources. The production site uses the single public origin
`https://cloud.admingod.ch`.

## Required cutover order

1. In the local Settings page, change the seeded login password and sign in
   again with the new password. Production preflight deliberately fails while
   any active account still uses the local seed password.
2. Stop local writes before taking the final dump. Back up the entire database,
   not only `users`: file names, object keys, permissions, repositories, upload
   completion records, and encryption envelopes live in PostgreSQL even when
   object bytes already live in S3.
3. Add a PostgreSQL service to the existing Aeralyth Railway project and restore
   the complete local dump into that fresh database before creating the public
   web deployment.
4. Compare source and destination row counts, then run `ANALYZE` on the restored
   database.
5. Connect the GitHub repository to one Railway web service on branch `master`,
   add the variables below, and enable **Wait for CI**. Do not configure watch
   paths; every push to `master` must wait for the complete GitHub workflow.
6. Deploy and verify health, login, and page rendering on the generated Railway
   domain. Do not use that origin for direct S3 upload/download verification.
7. Attach `cloud.admingod.ch`, add Railway's DNS records, and wait for its TLS
   certificate.
8. Apply the production bucket CORS policy and perform the complete browser
   upload/download checks at `https://cloud.admingod.ch`.

## Protected database transfer

Keep both connection strings in a temporary file outside the repository with
mode `0600`; do not paste them into source, CI logs, or shell commands. Load
that file into a dedicated terminal session, then create the dump in a private
temporary directory:

```bash
cutover_dir="$(mktemp -d)"
chmod 700 "${cutover_dir}"
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="${LOCAL_DATABASE_URL}" \
  --file="${cutover_dir}/aeralyth.dump"
```

Restore only into the new, empty Railway database:

```bash
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname="${RAILWAY_DATABASE_PUBLIC_URL}" \
  "${cutover_dir}/aeralyth.dump"
psql "${RAILWAY_DATABASE_PUBLIC_URL}" -X -v ON_ERROR_STOP=1 \
  -c "ANALYZE;"
```

Compare at least these counts on both databases before continuing:

```sql
SELECT 'users' AS relation, count(*) FROM users
UNION ALL SELECT 'files', count(*) FROM files
UNION ALL SELECT 'file_uploads', count(*) FROM file_uploads
UNION ALL SELECT 'repositories', count(*) FROM repositories
UNION ALL SELECT 'user_vaults', count(*) FROM user_vaults
UNION ALL SELECT 'vault_node_records', count(*) FROM vault_node_records
UNION ALL SELECT 'vault_object_generations', count(*) FROM vault_object_generations;
```

Keep the dump until the production application, files, and repository views
have all been verified.

## Web-service variables

Use Railway reference variables instead of copying resource credentials. If the
database service is named `Postgres`, set:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Use Railway's bucket credential injection from `aeralyth-storage-prod` so the
web service receives `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, and
`SECRET_ACCESS_KEY`. Then add:

```text
AERALYTH_ENV=production
AERALYTH_COOKIE_SECURE=true
AERALYTH_STORAGE_BACKEND=s3
AERALYTH_E2EE_MODE=migrate
AERALYTH_API_ORIGIN=http://127.0.0.1:8081
AWS_S3_URL_STYLE=virtual
AERALYTH_S3_CSP_ORIGIN=https://<exact-presigned-bucket-host>
AERALYTH_SHARE_LINK_SECRET=<stable-random-secret-at-least-32-bytes>
AERALYTH_METRICS_TOKEN=<stable-random-secret-at-least-32-bytes>
```

Seal the S3 credentials and both Aeralyth secrets in Railway. The CSP origin
must be the origin that appears in an actual presigned URL, without its path.

The current local database must be checked before choosing the E2EE mode:

```sql
SELECT e2ee_state, state, count(*)
FROM files
GROUP BY e2ee_state, state
ORDER BY e2ee_state, state;
```

Keep `migrate` while any active file is `legacy` or `staged`. Create/unlock the
encrypted vault in Settings and finish migration; only after the API reports no
remaining legacy or incomplete nodes should the variable change to `required`.
The API refuses to start in `required` mode while migration is incomplete.

## Bucket CORS

Apply `docs/railway-s3-cors.production.json` to
`aeralyth-storage-prod`. It allows direct presigned requests only from
`https://cloud.admingod.ch`; never replace that origin with `*`.

## GitHub and Railway deployment gate

The GitHub workflow runs on every push to `master`. In Railway service settings:

1. Connect the repository and select `master` as the trigger branch.
2. Enable automatic deploys.
3. Enable **Wait for CI**.
4. Leave watch paths empty so documentation, deployment, migration, and source
   changes all pass through the same gate.

Railway will then skip a deployment when any workflow check fails. The checked-in
`railway.json` also prevents activation when migrations, the production data
preflight, or `/health` fail.

This release establishes the production rollback floor for share-link token
versions. The initial service must be created from this revision or newer, and
`overlapSeconds` remains zero so no pre-version binary can serve requests after
version-one links become writable. Never redeploy or roll back to a revision
that lacks migrations 018-020 and version-aware owner listing. Once every
retained rollback target includes those changes, overlap may be re-enabled in a
later reviewed release.

## Domain

After health, login, and page rendering pass on the generated Railway domain,
add `cloud.admingod.ch` as the web service's custom domain. Add both records
Railway provides: the `CNAME` routes the subdomain and the `TXT` record proves
ownership. Target Caddy's Railway port and wait for Railway's certificate before
applying the single-origin S3 CORS policy and testing direct object transfers.

Reapply the production S3 CORS policy if the final origin differs from
`https://cloud.admingod.ch`.

## Post-deploy checks

1. `GET /health` and `GET /api/health` return `200`.
2. Login succeeds only with the changed password; the local seed password fails.
3. Settings loads, a password change signs out every active session, and the new
   password works.
4. File and repository counts match the local source database.
5. Open and download a known object from the Railway bucket.
6. Upload a small file and a multipart-sized file, then verify both appear after
   refresh.
7. Create and rotate a share link: the URL changes and the old URL is rejected.
8. Confirm the browser console has no CSP or S3 CORS failures.

Railway config reference: <https://docs.railway.com/config-as-code/reference>.
GitHub deployment gating: <https://docs.railway.com/deployments/github-autodeploys>.
Custom domains: <https://docs.railway.com/networking/domains/working-with-domains>.
