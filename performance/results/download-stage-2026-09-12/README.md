# Download scheduling acceptance, 2026-09-12

Executed `node performance/download-stage-profile.mjs` on an Apple M5 Pro running macOS arm64. This harness bundles the current download implementation and the actual serial implementation from commit `fe9556cf9f011297e16500f18cdf04b991b35635`. It does not substitute a calculated serial baseline.

Each runtime completed 24 transfers: four stage-delay profiles, three repetitions, and both implementations. Execution order alternates by repetition. Each transfer decrypts four 4 MiB AES-GCM chunks with real WebCrypto authentication. The sink checks each complete plaintext chunk against its expected SHA-256 digest; finalization requires all four hashes to match in order. Each runtime also completed the cancellation scenario.

| Runtime | Profile | Serial median ms | Pipeline median ms | Reduction |
|---|---|---:|---:|---:|
| Node 26.8.2 | network | 274.3 | 256.1 | 6.7% |
| Node 26.8.2 | crypto | 273.7 | 255.1 | 6.8% |
| Node 26.8.2 | sink | 274.8 | 258.3 | 6.0% |
| Node 26.8.2 | balanced | 384.0 | 195.8 | 49.0% |
| Chromium 151 | network | 296.0 | 261.9 | 11.5% |
| Chromium 151 | crypto | 296.6 | 263.6 | 11.1% |
| Chromium 151 | sink | 295.4 | 264.1 | 10.6% |
| Chromium 151 | balanced | 386.2 | 201.0 | 48.0% |

The network, crypto, and sink profiles inject a 60 ms delay in the named stage and 2 ms in the other stages. The balanced profile injects 30 ms per stage. The crypto delay models a slower crypto worker; these measurements do not demonstrate physical CPU saturation, real internet throughput, or physical disk throughput. Actual AES-GCM and SHA-256 computation runs in addition to those injected delays.

Every current transfer kept one active decryption, at most one queued ciphertext chunk, and at most two pending plaintext chunks. The maximum modeled stage total was 12,582,944 bytes for the pipeline and 4,194,320 bytes for the serial reference. Assertions enforce the individual queue limits and a conservative stage ceiling. This counter excludes ExactStreamReader transient input/output copies, the fixed encrypted fixture, crypto/browser internals, heap residency and RSS. It is a logical scheduling bound, not a heap measurement.

Both cancellation runs rejected the operation, performed exactly one sink write, aborted the sink and crypto session, and never closed or published a completed file. The separate encrypted-download, resumable-download and buffered-bytes functional suites cover aligned resume, expired URLs, changed generations and ETags, wrong ranges, progress stalls, final authentication failures, partial previews, trailing bytes and abandoned-buffer wiping.

Chromium ran in its own temporary localhost origin and isolated browser session. No application credentials, storage provider, user file, or production service was used. Firefox and Playwright WebKit executables are not installed. Safari unavailable: Could not create a session: You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver.

The injected crypto client validates AES-GCM and complete output digests. It does not exercise vault bootstrap signatures, the actual VaultCryptoClient worker transport, or a production Merkle tree. Those remain covered by separate worker and functional acceptance tests. The production S3 CORS configuration and live provider have not been validated by this harness.

Each raw result contains its own execution command, source hashes, baseline revision and host provenance. `provenance.json` records the completed combined run, including the Safari automation result. These source hashes permit checking whether a later source edit requires another measurement.

Reproduce with:

```sh
node performance/download-stage-profile.mjs
```

The baseline defaults to the pinned audit commit and can be overridden explicitly with `AERALYTH_DOWNLOAD_BASELINE_REF`. A missing browser or Safari pre-session automation refusal is recorded as unavailable; failures after creating a Safari session fail the runner.

The runner needs loopback listener permission, the installed agent-browser Chromium runtime, and macOS Safari WebDriver for the optional Safari attempt. It does not enable Safari remote automation or install browser runtimes.
