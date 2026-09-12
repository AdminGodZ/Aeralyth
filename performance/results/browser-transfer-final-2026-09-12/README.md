# Final browser transfer acceptance

The frozen native release and rebuilt production frontend passed the final authenticated browser flow. The browser was closed and the API window released before the remaining observability and production-image gates began. The [summary](summary.json) records sanitized request headers/timings and the source identities below.

| Artifact | Identity |
|---|---|
| Backend source SHA-256 | `6a9494aa3f7e781e81289f0a3f10b1f1590f5988e563753c30489897c8beefab` |
| Native binary SHA-256 | `744a513655b7efd0a28d7cf406a077f59aa05e3939ec48ead58234b236b0e7e8` |
| Production Next.js build | `kLh0LsUQEgybZ5ZUu3iqk` |
| Backend during the test | Isolated port 58083, PID 50750 |

The fresh account completed sign-in, automatic one-password vault setup and recovery acknowledgment. A 40-byte encrypted file and a browsable folder containing two files at different depths published successfully. Repository import then published three files, including a 40 MiB text file, with one nested folder. The recorded upload, preview and original-download traces contain no HTTP status of 400 or above.

The large text preview requested exactly `bytes=0-4194319`. The provider returned 206 with 4,194,320 bytes from a 41,943,200-byte ciphertext. The real production worker executed one `decryptChunk` call, taking 9.9 ms including worker message round-trip; it then aborted the partial decryption session. It did not claim complete-file Merkle verification. The [actual preview screenshot](preview.png) shows the 2 MiB/500,000-character display limits, partial-verification explanation, Raw preview and Download original controls.

The [independently reviewed temporary probe](preview-probe.js) observed CSS-visible fixture text within the viewport 228.3 ms after the click, followed by two animation frames at 278.7 ms. This is a rendering-opportunity proxy, not a compositor first-paint timestamp. It is one local sample, including route/data/decoder/highlighter/render work, and does not establish production latency. The provider prefix response took 19.895 ms in the local trace. The probe recorded only operation types, byte counts, durations and success flags; its observer, listeners, pending counters and prototype wrapper were cleaned automatically before the full download.

The complete original downloaded through the actual OPFS path as 41,943,040 plaintext bytes. Its SHA-256 matched the source:

`3d81051e2fbef8baeff1f79f67d2b940f64855acb3f6e975fbda5c1beef68405`

The exact immutable vault-worker asset was then blocked in this isolated browser. Reloading the previously unlocked page produced an [actionable locked state](worker-failed.png), with both the decrypted filename and content hidden. A subsequent unlock attempt also failed, cleared the password input and left the Unlock button enabled. The [captured locked page text](worker-failed.txt) preserves the recovery instructions. Removing the network block and reloading still required explicit account-password unlock. After that unlock succeeded, another complete 40 MiB download matched the same source hash. Post-recovery browser errors and console output were empty.

The network block was explicitly removed before recovery; the successful fresh worker and post-recovery download verify that recovery path. The preview probe had already reported `cleaned: true`. Closing the browser then removed the entire temporary realm and its interception state. No application source or Next build was changed by the browser checks; source-file hashes and the unchanged build ID are recorded in the summary.

The local fixture proxy allowed plain-HTTP MinIO in response CSP and removed `upgrade-insecure-requests` only for this isolated run. Production policy stayed unchanged. The session hid `showSaveFilePicker` to select OPFS, so this journey does not claim native save-picker, Safari or Firefox coverage. A premature file-input action and an incorrectly quoted batch wait were corrected before successful folder publication; neither was an application failure. Raw HAR files remain outside the repository because they contain disposable signed URLs and authentication context; the saved trace strips those values.

The [earlier real browser record](../browser-transfer-2026-09-12/summary.json) separately preserves successful interrupted-range recovery and authenticated ETag invalidation. The final pass adds evidence tied to the frozen backend plus worker recovery and bounded-preview measurements; it does not relabel the earlier run as this final binary.

`frontend_transfers/downloads` independently approved the final evidence with no corrections. The file-only review checked the summary identity, eight frontend and 40 backend source hashes, build and native binary identities, source/output file hashes, raw versus sanitized preview/download traces, normalized probe code and metrics, screenshots, locked-state text and empty post-recovery logs. It made no API or browser requests. The [review record](review.json) binds that approval to the formatted summary bytes.
