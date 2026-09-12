# Migration progress regression evidence

The repaired migration-progress triggers passed the local PostgreSQL correctness and statement-budget checks on 12 September 2026. The bulk fixture contains two accounts with **5,000 and 100,001 legacy nodes**, including their roots, under the complete schema installed for this capture. Each source statement inserts at most 1,000 nodes or updates at most 5,000 nodes.

| Operation | Source statements | Maximum elapsed time | Migration counter writes |
| --- | ---: | ---: | ---: |
| Trash and restore | 44 | 6,236.835 ms | 0 |
| Pending to failed | 22 | 272.222 ms | 0 |
| Failed to complete | 22 | 375.070 ms | 22 |

All statements ran with a **10-second statement timeout** and a **3-second lock timeout**. The SQL checks exact legacy and incomplete counts after each phase. A temporary trigger records counter writes, so the zero-write assertions cover the actual database behavior. The completion assertion requires exactly one counter write per account and source statement. The final transaction rolls back all fixture data and test instrumentation.

`bulk-regression.log` contains the successful psql output. `bulk-results.json` retains every measured statement time, the command, source hashes, limits, and fixture details. Each phase also prints the time for the SQL statement that generates its commands; that final timing is recorded separately and excluded from the mutation counts above.

The original canonical backend test failed because a correlated anti-join repeatedly scanned an unindexed transition table while trashing 5,000 legacy nodes. `prior-canonical-failure.log` preserves that failure. Migration 028 now computes the changed `(owner, node, E2EE state)` sets with materialized `EXCEPT` operations before joining the indexed progress table. Migration retries compare their complete/incomplete contribution, so changing between unfinished states does not rewrite the counters.

An independent reviewer also ran the fresh/backfill/replay and concurrent-transition regression against a separate disposable database. `fresh-independent.log` records the successful result, including staged/incomplete overlap, retries, cleanup, rollback, ownership changes, cascading deletion, reconciliation, and bulk-write checks. Its actual query-plan captures examined 1,000 summary rows for 1,000 progress reads, and 2,000 summary rows for 2,000 reads, with no source-node scan. The reviewer approved migration 028 at SHA-256 `d4dff9325e52ff506e46f925feb8e02a1c806f34f569864637c37e2175c70f55`, the bulk SQL, and the full-chain wrapper after inspecting the successful 44 + 22 + 22 statement capture. No actionable review findings remained.

The bulk capture used disposable database `aeralyth_audit_progress_bulk` in local container `aeralyth-audit-20260912`. Setup cloned the immutable 001–027 template and applied every SQL migration present from 028 through 036; the repository has no migration numbered 033. The successful setup output is in `schema-install.log`. `database-schema.sql` preserves the actual installed public schema without data, ownership, or grants, and `database-versions.log` records PostgreSQL and migration versions. Their SHA-256 hashes are included in `bulk-results.json`. The bulk command was:

```sh
docker exec -i aeralyth-audit-20260912 \
  psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d aeralyth_audit_progress_bulk \
  < database/tests/migration_progress_bulk.sql
```

The automatic full-chain entrypoint repeats setup, executes the same SQL, and removes its disposable database:

```sh
PG_CONTAINER=aeralyth-audit-20260912 \
MIGRATION_TEST_TEMPLATE=aeralyth_audit_baseline \
  bash database/tests/fresh_migration_progress_bulk.sh
```

Without either environment variable, the entrypoint uses the Compose PostgreSQL service and creates an empty database before applying the entire migration chain. The new wrapper passed `bash -n`; this particular capture used the equivalent migration loop and direct SQL invocation above.

These are controlled local regression results. Timings include the complete installed trigger set and PostgreSQL execution; they do not isolate the cost of migration-progress bookkeeping. The test disables synchronous commit and does not measure durability latency, production throughput, browser interaction, or concurrent tenant load. The root task owns the separate final backend-suite run against the final schema.
