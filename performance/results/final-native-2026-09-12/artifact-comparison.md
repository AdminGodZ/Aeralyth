# Final artifact comparison

All three artifacts passed the same fixed-arrival mixed workload and idle-maintenance gate. Each run offered 400 operations across a 5-second baseline, 30-second mixed phase and 5-second recovery.

| Artifact | Mixed p99 ms | Failed/dropped | Peak memory MiB | Memory growth MiB | Busiest idle worker iterations/s |
| --- | ---: | --- | ---: | ---: | ---: |
| debug | 52.40 | 0/0 | 71.11 | 4.42 | 0.00 |
| release | 50.02 | 0/0 | 50.95 | 2.88 | 0.00 |
| production-image | 45.16 | 0/0 | 94.21 | -12.38 | 0.00 |

These are one-run local comparisons of the same arrival workload and encrypted fixture, not repeated statistical estimates.

Native binaries use Rust 1.97.1 on unrestricted macOS arm64; the actual production image uses Rust 1.98 on Linux arm64 with a two-CPU quota and 2 GiB memory limit and the full Caddy routing path.

Native memory is API process RSS; image memory is the whole Caddy/Next/API cgroup, so their memory totals have different scopes.

Each artifact uses its own newly initialized database and S3 bucket on the same isolated PostgreSQL/MinIO services.

Record timestamps establish run order. Timing samples were collected sequentially without concurrent builds or other audit workloads.

Request p99 includes service completion and scheduling delay. The workload is primarily database/provider work, so differences do not establish universal CPU or production capacity gains.

HTTP 500 is not injected in these mixed runs. The separate database-stall reports deliberately fail the performance gate while their validating self-test succeeds.
