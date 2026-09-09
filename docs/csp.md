# Runtime styles and ZIP assets under CSP

Production uses a nonce for style elements and permits only same-origin workers
and connections (plus the configured storage origin). Keep these restrictions
when adding UI components or browser libraries.

## Confirmed problems and fixes

- Radix Select inserted its viewport CSS without a nonce. The browser blocked
  the stylesheet, including the rules that hide the viewport's native scrollbar.
  `SelectContent` now passes the document nonce to `SelectPrimitive.Viewport`.
- Popup scroll locking uses `react-remove-scroll`, whose stylesheet is inserted
  through `react-style-singleton`. Before the fix, opening a popup set the body's
  lock attribute but left its computed overflow `visible`. `CspNonceProvider`
  registers the nonce through `get-nonce` before the library's style effects run.
- zip.js attempted to create a blob worker and fetch an embedded data-URL WASM
  module. CSP blocked both. Its fallbacks could still produce valid ZIP files,
  but losing the compression worker can put compression work on the page thread.
  The shared ZIP entry point now uses hashed, same-origin worker and WASM assets.
  Both the page and the folder ZIP worker use this configuration.

The nonce provider preserves the initial document nonce across client navigation
and `router.refresh()`. A fresh server response has a different nonce, but the
browser continues enforcing the original document's policy until a full load.
The theme provider uses the same preserved nonce. No nonce is written to a
process-global registry during server rendering.

`npm run worker:build` copies zip.js's matching codec worker and WASM module from
the installed package, fingerprints their bytes, and generates `zip-assets.ts`
before bundling the folder worker. Existing `/workers/*` cache headers and Docker
public-asset packaging cover these assets. The CSP directives are unchanged.

## Local verification — 2026-09-09

- Tested a production Next build with its production CSP and a disposable local
  account. Opening the upload popup and settings Select reproduced the blocked
  styles before the fix.
- After the fix, both generated popup styles had the document nonce and active
  stylesheets; body overflow was `hidden` while open. Checked dark and light
  modes, client navigation, and a profile update delivered through SSE.
- The SSE refresh response had a different nonce from the document. Reopening
  the popup still used the document nonce, with no CSP violations.
- Exercised the actual streaming ZIP destination with forced WASM compression
  and the folder ZIP worker. Both archives decoded to the exact original content.
  The generated codec worker and WASM asset were requested from the same origin;
  neither flow emitted CSP violations after the fix.
- 313 frontend tests, 45 performance tests, lint, TypeScript, and the production
  build passed. Asset tests check fingerprints and compile the emitted WASM.
  Independent review found no actionable issues.

This is local validation, not production deployment evidence. The HTTP-only
preview cannot follow the profile-save redirect after production CSP upgrades it
to HTTPS; theme coverage therefore also used a database update delivered through
SSE. Deployment serves HTTPS. No production settings were changed during testing.
