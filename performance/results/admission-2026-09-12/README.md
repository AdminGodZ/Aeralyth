# Backend admission measurement records

The final acceptance evidence is in `diagnostic-matrix/results.json` and its matching `run.log`. The complete test passed in 42.35 seconds. All 2,400 partitioned-profile requests succeeded, with no rejections or HTTP 500 responses. Both load levels passed the comparisons requiring lower pooled successful-handler p99, no increase in rejections, and continued bulk progress. The two profiles together retain 4,800 raw samples.

This measures backend handler completion in a local debug test. It does not measure browser rendering, client decryption, S3 latency, or production latency. The shared profile is a same-build counterfactual using a shared admission gate, rather than an older deployed binary.

## Final comparison

Each row pools three repeats, with 600 requests offered per cohort and profile. Latencies include successful requests only. Rejections remain in the denominator and are reported alongside latency. All errors in this final matrix are explicit shared-gate HTTP 503 responses with the diagnostic message `recursive operation capacity is full`.

| Total offered requests/second | Cohort | Shared p95 ms | Partitioned p95 ms | Shared p99 ms | Partitioned p99 ms | Shared rejected/offered | Partitioned rejected/offered |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | Same user as provider operation | 8.958 | 11.467 | 738.249 | 12.371 | 105/600 | 0/600 |
| 100 | Other user, also running bulk work | 49.253 | 11.524 | 53.085 | 13.435 | 0/600 | 0/600 |
| 200 | Same user as provider operation | 9.118 | 11.054 | 749.669 | 13.526 | 216/600 | 0/600 |
| 200 | Other user, also running bulk work | 49.077 | 11.474 | 52.234 | 15.746 | 217/600 | 0/600 |

Same-user successful-request p95 increased modestly. The shared gate rejects most requests arriving during its provider delay, leaving a selected set of successful samples. The result supports lower p99 and greater request acceptance, not an improvement in every percentile. For the same-user cohort, the shared profile accepted only 9 of 111 provider-window requests at 100 requests/second and 9 of 222 at 200 requests/second. The partitioned profile accepted all 111 and all 222. Percentiles from the nine successful shared-profile samples should be read as a small-sample description, not a stable tail estimate.

Bulk work completed 130/130/131 queries per partitioned run at 100 requests/second, versus 94/94/93 with the shared gate. At 200 requests/second, the corresponding counts were 67/66/67 versus 44/44/43. During the 750 ms provider delay, partitioned runs completed 23 to 25 bulk queries each. Each query traverses the fixed 501-node fixture and includes a 20 ms PostgreSQL sleep. The 100 requests/second runs last four seconds and the 200 requests/second runs last two seconds, so totals should be compared within the same load level.

Maximum arrival lag stayed below 4.4 ms. The report preserves scheduled-to-completion latency as well as handler latency, all individual samples, per-run results, provider-window denominators, and every non-successful response's bounded error details.

## Verification and provenance

The team paused other CPU and database benchmark work for the final measurement. The database's corrected migration 028 functions and the typed checkout-admission overload-to-503 mapping were present. The final run did not produce a checkout-admission error. The mapping's separate focused tests establish that behavior; the earlier eight HTTP 500 responses remain uncorrelated because their original samples did not save error text.

`diagnostic-matrix/binary.json` records the exact copied test binary and its SHA-256. `database-schema.sql` records the measurement database schema. All five compiled source hashes matched the current files when the final report was checked. `sandbox-denied.log` records an earlier launch blocked from localhost by the restricted shell before setup or any samples; the successful run used approved access to the isolated local database.

The final JSON SHA-256 is `4fa4491e39380861c68d13a1394fc94c1216e1c795682a26ac0e771747ecccca`.

Recompute every reported count, maximum, and nearest-rank p50/p95/p99 from the raw samples with:

```sh
python3 performance/results/admission-2026-09-12/verify_results.py \
  performance/results/admission-2026-09-12/diagnostic-matrix/results.json
```

The saved `diagnostic-matrix/recomputed-summary.json` contains the verified aggregate comparison. No sample was removed to obtain the passing result.

## Preserved failed matrix

`failed-matrix-before-error-diagnostics/results.json` and its matching `run.log` preserve the first complete 100/200 requests-per-second matrix. All 4,800 raw samples reconcile with the recorded status counts, provider-window counts, and nearest-rank percentile distributions.

The test failed. One partitioned run at 100 requests per second returned eight HTTP 500 responses. Across that load level, other-user partitioned p99 was 56.173 ms versus 53.813 ms for the shared-gate counterfactual, and rejections were 12 versus zero. The eight HTTP 500 responses occurred in the run whose maximum arrival lag reached about 208 ms. This timing association does not establish the cause. The original samples saved only status codes, so the exact handler errors are unavailable. The PostgreSQL log for the run window is preserved as `postgres.log`; it does not identify a corresponding admission-fixture SQL error.

The preserved JSON SHA-256 is `4736599f61a64a679b6a5e55782d1e77f54d501be4cf379219103e861423bdd3`.

## Unpaired pilot artifacts

`pilot-200rps-results.json` and `pilot-200rps-run.log` are retained as separate historical records. They do not describe the same observed run. For example, the JSON's first partitioned run reports zero rejections and 71 bulk completions, while the log reports 29 rejections and 64 bulk completions. The cause of the mismatch is unverified. Neither file supplies paired acceptance evidence.

The measurement now defaults to a unique temporary output directory. Durable invocations explicitly select a unique report directory, avoiding reuse by unrelated ignored-test runs.
