# Complete final backend verification

The final run passed **268 tests, zero failures and zero ignored tests** in 179.96 seconds. It used a fresh isolated PostgreSQL database, `aeralyth_audit_final_backend_v4` on localhost port 55434, with all 35 current migrations applied. Database integration, local network fault tests and the scale fixture were enabled.

```sh
AERALYTH_DATABASE_INTEGRATION_TESTS=1 cargo test --locked --manifest-path backend/Cargo.toml -- --include-ignored --test-threads=1
```

`DATABASE_URL` was set to the disposable audit database. The complete command, timing, exit code, log hash and before/after source verification are in `summary.json`. All Rust source, Cargo manifest/lock and migration hashes remained unchanged during execution. `cargo-test.log` retains the complete output. The database initialization commands and migration hashes are in `../database-audit-2026-09-12/backend-final-v4-init.json`.

An earlier complete run passed 267 tests and failed the experimental Fast-recycling recovery assumption. That output and the independently reviewed test-only correction are retained in `../recycling-2026-09-12/`. Production keeps Verified recycling. Recovery probes may retry a harmless read; neither writes nor COMMIT are replayed. The corrected tests passed the author's focused run, two independent repeats, and this complete run.

Final Rust formatting and all-target Clippy with warnings denied passed; their logs are retained in `../recycling-2026-09-12/fmt.log` and `../recycling-2026-09-12/clippy.log`. Native release, production image, browser and load verification have separate artifact identities and results. This run did not deploy or exercise production.
