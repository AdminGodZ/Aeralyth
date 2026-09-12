# Worker performance verification, September 12, 2026

This is local evidence for PERF-038 and PERF-039. The implementation and its
runtime checks were performed by separate agents. These checks do not establish
deployment to production or mobile-network performance.

The machine was an Apple M5 Pro with 15 logical CPUs and 24 GiB RAM, running
macOS on ARM64 with Node 26.8.2 and headless Chromium 151. The complete samples,
asset hashes, sizes, and machine metadata are saved in
[`performance/results/worker-2026-09-12.json`](../performance/results/worker-2026-09-12.json).

## Exact production bytes

`npx vitest run src/generated/production-workers.test.ts` passes all three tests.
The test host reads each hash-named file from `public/workers` and imports its
unaltered bytes as an ES module. It supplies worker messaging and browser globals
through `node:worker_threads`; it does not compile the source worker for the test.

- Checksum: empty input, the standard `abc` SHA-256 vector, and a 5 MiB input that
  crosses the incremental hashing boundary.
- Vault: the real 256 MiB Argon2 preflight, vault setup, signed record creation,
  AES-GCM encryption and authenticated decryption, finalization, and rejection
  after locking.
- ZIP: a compressible file and directory are written and read back. The test
  disables native compression to force the WASM fallback and verifies that the
  exact hash-named WASM asset was requested and successfully used.

The same emitted workers also passed in isolated Chromium 151 on macOS. A local
fixture served the existing worker files unchanged with a same-origin CSP that
allowed WebAssembly compilation. The browser verified the checksum vector, ZIP
readback, Argon2 preflight, and signed AES-GCM round trip without worker errors.

## Delivered bytes

These measurements compare the audit-start assets with the first minified audit
build. They include the source changes present in that build. Compression uses
Node 26.8.2 zlib defaults, so Caddy's exact encoder output can differ.

| Worker | Raw before | Raw after | Gzip before | Gzip after | Zstd before | Zstd after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vault | 811,315 | 649,694 | 240,748 | 221,911 | 236,268 | 216,882 |
| Folder ZIP | 326,352 | 126,465 | 80,801 | 58,031 | 84,731 | 60,399 |
| Upload checksum | 12,280 | 6,429 | 4,422 | 3,113 | 4,641 | 3,269 |

The tested after hashes begin `4906616f` for vault, `6e182749` for ZIP, and
`a68b28db` for checksum. Later builds can change these hashes as other audit fixes
land. Regenerate current measurements with:

```sh
node scripts/measure-worker-assets.mjs
node scripts/measure-worker-assets.mjs /path/to/baseline-assets
```

The optional baseline directory accepts original worker files or their archived
`.gz` files. Zstd is reported as `null` on Node versions without its built-in API.

## Browser startup

Seven newly constructed workers per version were measured in Chromium, loading
from a localhost server with `Cache-Control: no-store`. Each timing includes
loading the worker and receiving its first small response. The vault request was
`lock`, so its figure measures readiness without the deliberately expensive KDF.
The other requests were an empty checksum and an empty ZIP. The full Argon2
preflight was separately executed as a correctness check.

| Worker | Before median | After median |
| --- | ---: | ---: |
| Vault | 12.6 ms | 12.3 ms |
| Folder ZIP | 7.3 ms | 7.1 ms |
| Upload checksum | 3.4 ms | 3.7 ms |

These small differences on a desktop are within a range where machine noise and
cached filesystem data matter. The measured compressed-byte reduction is the
stronger result. No slow-network or mobile-device startup claim is made.

The saved figures come from the checked-in browser fixture. An earlier run
returned 10.7/10.4 ms for vault, 6.2/5.5 ms for ZIP, and 2.6/2.5 ms for checksum,
which also illustrates the variability of these short timings.

To reproduce, run:

```sh
node scripts/benchmark-worker-browser.mjs /path/to/baseline-assets
```

Open the printed localhost URL in an isolated browser session. The page runs the
correctness checks and seven startup samples per worker and version, then prints
the JSON result. Browser automation can read `window.workerResults`. The optional
baseline directory must contain one version of each application worker, as
original files or `.gz` archives. Omitting it measures the current version only.
The runner bundles `scripts/test-fixtures/production-worker-browser-checks.mjs`
for the test page and serves the actual production workers unchanged.

## Retained worker URLs

A separate Chromium session loaded a fixture containing only the three original
build-A URLs. Before the check, its recorded worker count was zero and its only
resource request was the favicon. The fixture then lazily created those workers
using their original `/workers/<name>.<hash>.worker.js` URLs against build B's
Caddy server at `http://127.0.0.1:18090`. The old vault passed Argon2 preflight,
the old checksum worker returned the known digest, and the old ZIP worker
produced an archive. No substitution of the new worker URL was involved.

This exercises an old client's delayed worker request against the new release;
the fixture represents the retained page and does not perform a live production
deployment. The temporary fixture was removed after the check.

`node scripts/test-worker-http.mjs http://127.0.0.1:18090` independently verified
all eight archived/current assets against Caddy. Exact decoded hashes matched,
gzip responses worked, existing assets had immutable browser/CDN cache headers,
and a missing hash returned an uncached 404.

`npx vitest run scripts/worker-asset-store.test.ts src/generated/worker-assets.test.ts deployment/production-config.test.ts`
passed 21 tests. The archive test copies only the release archive from A into a
fresh B directory, restores A's JavaScript and WASM, and publishes B without a
previous public directory or builder cache. Corrupted and hash-mismatched assets
are rejected. `node scripts/verify-worker-release.mjs --content-only` passed.

The full release gate additionally requires the manifests and archives to be
committed. Passing the content check while the implementation is uncommitted does
not claim that the release gate or remote CI has passed.

## Independent implementation review

The reviewer inspected the immutable archive helper, worker and ZIP publication
scripts, release verification gate, Docker copies and ignores, Caddy routing,
minification options, and retention policy. No remaining defect was found in the
reviewed implementation after updating the old Caddy configuration assertions.

The archive preserves exact protocol bytes and ZIP dependencies across fresh
forward deployments. It has no automatic pruning; the documented policy retains
assets referenced by supported releases and rollback releases. Minification
precedes hashing, license comments remain in the public bundle, and source maps
and esbuild metadata stay outside public assets. Missing workers receive an
explicit uncached failure instead of an immutable negative cache entry. Actual
production deployment, release commit verification, and the separate client
terminal-failure implementation are outside this review's verified scope.
