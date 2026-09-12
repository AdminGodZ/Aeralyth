# Folder preparation acceptance profile, 12 September 2026

PERF-030 was exercised through the current production `publishEncryptedFolderTree` implementation. This profile measures dependency scheduling, publication readiness, bounded record/session ownership, and cleanup. Crypto and publication calls use controlled asynchronous adapters. It does not measure real encryption, database latency, browser behavior, file PUTs, or RSS.

Run from the repository root:

```sh
node performance/profile-folder-preparation.mjs
```

Set `AERALYTH_FOLDER_PROFILE_OUTPUT` to an alternate JSON path for an independent rerun. The script bundles the current helper with its real hardware-concurrency helper, records both source hashes, and removes its temporary bundle afterward. No credentials, account, or storage service are used.

Each successful fixture contains 1,000 folders. Worker start and finalization each wait 1 ms; publication waits 4 ms. These are controlled delays, not measured service latencies. Actual elapsed times include Node timer granularity, scheduler work, validation, and instrumentation. The hardware hint is eight cores, with a maximum of four crypto operations. Each row is one run.

| Scenario | First file becomes eligible | All folder preparation finishes | Folders still unpublished at first eligibility | Peak outstanding records | Publication requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wide: 1,000 independent file parents | 15.5 ms | 583.3 ms | 984 | 28 | 66 |
| Deep: ten branches, each 100 levels | 249.6 ms | 735.9 ms | 600 | 100 | 10 |
| Empty-heavy: one file parent, 999 empty siblings | 14.3 ms | 617.0 ms | 984 | 100 | 11 |

“First file becomes eligible” means the helper calls `onPublished` after the file's parent is durably published. It does not mean the file has started a PUT. The earlier all-folders barrier could not release a file until all folder preparation finished; the JSON records that same-run timing as an eligibility bound, not a measured historical implementation. There is no baseline speedup claim.

Early publication trades some request batching for earlier file eligibility. In this wide fixture, the 8 ms priority-parent flush produces 66 publication requests instead of the ten requests needed if every batch waited for 100 records. The deep and empty-heavy fixtures use ten and eleven requests. These counts are reported so the effect of real publication latency can be evaluated separately.

All three successful scenarios assert that at least 100 folders remain unpublished when the first file becomes eligible. Every preparation checks that its parent's key has finalized. Every publication checks that each parent is either already durable or appears earlier in the same batch. The deep fixture executes 990 checks of each kind. Depth 100 is the production selection uploader's maximum supported depth.

The bounds are counts, not bytes. Across all scenarios, at most four crypto tasks and 100 outstanding records exist at once. “Outstanding” includes worker starts, finalized records, and records being published. The adapter generates dummy record arrays, so these counts do not establish real encrypted-record heap usage. Every callback also checks durable publication, the folder ID mapping, and prior share-job enqueueing.

Two additional scenarios verify cleanup:

- The second 100-record publication fails. The helper retains all 100 already published keys, cleans all 100 unpublished sessions, and leaves no pending work. Completion, including cleanup, takes 124.5 ms in this run.
- Cancellation arrives after 2 ms while four worker starts each wait 20 ms. The helper waits for the late session responses, cleans all four, and publishes nothing. Completion takes 21.1 ms and leaves no pending work.

The [JSON results](folder-preparation-2026-09-12.json) contain the source hashes, measurements, all batch node/parent identities, invariant-check counts, and the first/last twenty trace events per scenario. Assertions execute over every folder and batch. The mostly empty fixture calls the folder helper directly; ordinary `File` selections do not themselves represent empty directories. Real browser acceptance and live service throughput remain separate checks.
