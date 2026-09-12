# PostgreSQL recycling fault verification

Production keeps `RecyclingMethod::Verified`. Fast saves time on healthy checkouts but exposes failed reads after connection termination. This experiment does not establish an HTTP latency or production throughput benefit.

The final whole-backend run recorded in `before-full-suite.log` passed 267 tests and failed one experimental Fast-policy test. After terminating an active transaction, the test returned its connection to the pool and immediately attempted a new INSERT. Fast could hand the test the same connection before its asynchronous driver had recorded closure; the INSERT then returned `Postgres(Error { kind: Closed, cause: None })`. Verified had completed its profile with zero failed reads. This was a recovery assumption in the test, not a reason to change production recycling.

The correction is entirely inside the `#[cfg(test)]` module in `backend/src/db.rs`:

- Recovery retries only a harmless `SELECT 1, pg_backend_pid()` probe, with a one-second elapsed deadline and five-millisecond backoff. Each failed probe is counted, and deadline failures retain the last error in their diagnostic.
- Each `pg_terminate_backend` call must report that its signal was sent. A successful probe on the signalled backend is recorded separately and cannot count as recovery.
- After an interrupted transaction, the test retains the client that passed the probe and attempts the later explicit INSERT once. Neither the interrupted transaction, INSERT nor COMMIT is retried.
- The same bounded read helper verifies recovery after the separate TCP partition/lost-acknowledgement test. The partition must cause an error, and a committed write with a lost reply must exist exactly once.
- Both policy profiles retain 500 measured healthy samples and 25 idle termination/recovery observations. Interrupted writes leave zero rows; subsequent explicit writes create one row.

`focused-author.log` records both corrected tests passing. `independent-1.log` and `independent-2.log` record separate reviewer reruns of the identical compiled binary. `fmt.log` is empty because `cargo fmt --check` passed without diagnostics; `clippy.log` records `cargo clippy --locked --all-targets -- -D warnings` passing. These focused results do not replace the final whole-backend run coordinated separately.

The first author run measured the following. Values are microseconds, except counts. The recovery p99 over 25 observations is the maximum observed value. Recovery values include the deliberate five-millisecond backoff when a probe fails, so they should not be treated as the same measurement protocol as the earlier four-immediate-retry experiment in `docs/performance-resource-phases-2026-09-12.md`.

| Measurement | Verified | Fast |
| --- | ---: | ---: |
| Healthy checkout p95 / p99 | 433 / 760 | 3 / 6 |
| Healthy request p95 / p99 | 826 / 1,243 | 297 / 370 |
| Failed safe reads after 25 idle terminations | 0 | 23 |
| Idle recovery p99 | 28,728 | 36,030 |
| Failed post-transaction recovery reads | 0 | 0 |
| Post-transaction recovery | 27,515 | 28,835 |
| Committed rows after interrupted / later explicit write | 0 / 1 | 0 / 1 |
| Committed rows despite lost COMMIT acknowledgement | 1 | 1 |
| Safe read after network restoration | 28,384 | 26,672 |

The source file SHA-256 is `292f8032d1df6a72aa642018b2ccb94b1ebaeaa2c980844afd3e3459d0928d97`; the debug test binary SHA-256 is `44f1c8e05240d2adfef46d88776400523ce474a6ba102cd1309762d696da4644`. The tests used the isolated audit PostgreSQL instance on localhost port 55432. They create and remove only their two `performance_*_writes` tables.

To repeat against an isolated PostgreSQL database with `DATABASE_URL` already configured:

```sh
cargo test --locked --manifest-path backend/Cargo.toml recycling_ -- --include-ignored --test-threads=1 --nocapture
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
```
