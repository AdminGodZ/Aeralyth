# Database migration contract

Numbered migrations are immutable after deployment. Add a new numbered file for
every later schema or data change instead of appending work to an applied file.

Any migration that can scan or modify application rows must:

1. run inside a transaction;
2. acquire a migration-specific PostgreSQL advisory transaction lock;
3. check its immutable version in `schema_migrations` before doing work; and
4. record the version only after all work succeeds.

Large data backfills belong in a dedicated migration with resumable keyset
batches and an explicit progress record. They must not be placed in a migration
that is replayed by routine deployments.

Run `npm run db:test:migration-replay` after changing migration infrastructure.
It executes the base migrations twice in an isolated database and rejects any
application-row write during the second pass.
