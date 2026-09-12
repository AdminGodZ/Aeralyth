# Immutable worker releases

This directory is a release archive, checked into Git. Every gzip filename names
the SHA-256 of the original bytes. `npm run worker:build` archives new bundles and
restores all retained JavaScript and WebAssembly assets into `public/workers`.
Docker copies that complete directory into the runtime image. A fresh builder
therefore serves an older tab's original worker URL, including that worker's ZIP
codec and WASM dependencies, after a new release replaces the container.

Commit new `.gz` files together with both `src/generated/*-assets.ts` manifests
after building. CI runs `worker:verify-release` after generation and rejects a
release whose current assets are not committed. Never change bytes behind an
existing hash, redirect an old URL to a new worker, or include `.worker-reports`
in public assets. Reports contain private source maps and esbuild input metadata.

The compatibility policy supports tabs opened within the previous 30 days. The
archive currently retains all captured releases, with no automatic pruning. If
archive size later requires pruning, keep every asset and transitive dependency
referenced by every production release in that 30-day window and every supported
rollback release. Asset age is measured from its last referencing release, not
from when its hash first appeared. Record the release evidence before removal.

Asset retention preserves protocol identity. The browser never substitutes a
current worker for an unavailable version. A worker that cannot start must fail
its caller explicitly; the vault recovery flow clears dependent sessions and
requires a fresh unlock. An update must never silently reload a page that holds
unsaved state or a live transfer. Future backend protocol-breaking changes must
retain compatibility for the same 30-day window or explicitly coordinate a safe
user-driven update. Next's deployment identifier alone does not cover these
custom worker URLs.

The archive was seeded from the production bundle hashes present before the
September 12, 2026 performance changes. It includes old ZIP support files as well
as the three application workers.
