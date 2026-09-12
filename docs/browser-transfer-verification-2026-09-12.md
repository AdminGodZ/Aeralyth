# Browser transfer verification, September 12, 2026

The [final browser acceptance record](../performance/results/browser-transfer-final-2026-09-12/README.md) now covers the frozen backend and final frontend build, including worker-failure recovery and measured preview work. The earlier journey below remains separate evidence for interrupted-range recovery and ETag invalidation.

The actual application completed encrypted upload, preview, download and interrupted-download recovery in an isolated Chromium session. The frontend was the minified production Next.js build `GTPGa4Ulncax8uiFu9uA7cat`, with its exact generated production workers. The initial backend was the isolated native release on port 58081, with a fresh account, required encryption, a 1 GiB quota and local MinIO storage. A focused check against the final backend rebuild remains separate.

The durable [result and sanitized request timings](../performance/results/browser-transfer-2026-09-12/summary.json) contain no cookies, authorization tokens, signed URL queries or file content. The [preview screenshot](../performance/results/browser-transfer-2026-09-12/preview.png) shows the actual bounded preview and its verification label.

| Journey | Observed result |
|---|---|
| First account use | Signed in, completed the one-password vault setup and acknowledged recovery information through the actual UI. |
| Mixed encrypted upload | Published a 40 MiB text file and a 40-byte file. The large file used two multipart PUTs; the tiny file published before the first large PUT started. The first large PUT started about 227 ms after its upload initialization began. |
| Folder upload | Uploaded a folder containing a root README and a nested text file with the uncompressed, browsable folder option. Both appeared. |
| Repository import | Imported a repository containing the 40 MiB file, README and nested text file. Its tree and decrypted names appeared. |
| Bounded text preview | Requested `bytes=0-4194319`; MinIO returned 206 with exactly 4,194,320 bytes from a 41,943,200-byte ciphertext. This authenticates one complete 4 MiB chunk for the 2 MiB display budget. The UI showed its 500,000-character cap, partial verification explanation, Raw preview and Download original controls. |
| Complete original download | Saved exactly 41,943,040 plaintext bytes through the OPFS path. Its SHA-256 matched the source: `3d81051e2fbef8baeff1f79f67d2b940f64855acb3f6e975fbda5c1beef68405`. |
| Interrupted download | A test wrapper ended the first provider body at 4,194,327 ciphertext bytes, seven bytes into the second chunk. The application renewed its request at `bytes=4194320-41943199`, keeping the authenticated first chunk. The saved 40 MiB file matched the same source SHA-256. |
| Repository conditional read | An authenticated unchanged read returned 304 with an empty body. Trashing a child forced 200 with a changed validator and two entries; restoring it forced 200 with another changed validator and three entries. The summary explicitly marked its queued refresh stale. |

The successful preview provider request took 23.874 ms and the complete original provider response took 222.095 ms in their local HAR traces. These are single local network observations, not full user-visible latency or production performance claims. Browser paint timing and peak memory were not measured in this journey. Comparative upload/download profiles are recorded separately.

Two fixture adjustments were explicit. The temporary proxy allowed only the local plain-HTTP MinIO origin in response CSP and removed `upgrade-insecure-requests` for this isolated session; production source policy was unchanged. The session hid `showSaveFilePicker` to exercise the actual OPFS compatibility path; this browser journey does not claim native save-picker coverage. The interrupted-download wrapper altered one browser response stream and then allowed genuine provider requests normally.

The initial upload attempted before the local CSP allowance was blocked by the production policy. Staged uploads were aborted, and the complete journey was repeated successfully after correcting the test fixture. An attempted `/tree` endpoint and a mutation response parsed without an `Accept: application/json` header were test-harness mistakes and were corrected before recording the conditional-read results.

The original local traces and downloaded fixture files remain outside the repository. Their binary HAR `bodySize` values are not used as byte evidence: saved-file length and actual HTTP Content-Length/Content-Range headers provide the counts above. The ETag browser check covers authenticated reads and child mutations; share-recipient revocation has separate actual PostgreSQL regression evidence.
