# Encrypted upload pipeline profile, 12 September 2026

PERF-029 and PERF-035 now have controlled execution measurements through the actual upload implementation at the multipart boundary, 64 MiB, 128 MiB, and the maximum accepted ciphertext length of 2,415,919,104 bytes. The maximum case processes 576 generated crypto chunks and 72 real multipart buffers. It does not allocate a 2.4 GB source file.

This profile measures scheduling, assembly, checksumming, and buffer ownership. It is not a live network benchmark or a measurement of encryption speed. The production uploader calls controlled crypto, authenticated API, and storage adapters. The script performs real SHA-256 checksums and native buffer copies, and holds real PUT bodies until the simulated requests settle.

Run it from the repository root:

```sh
node --max-old-space-size=128 --expose-gc performance/profile-encrypted-upload.mjs
```

The script compares the current uploader with its exact historical entrypoint at `fe9556cf9f011297e16500f18cdf04b991b35635`. Both use the same current semaphore, assembler, protocol, and retry helper modules. The artifact records the entrypoint and helper source hashes. The historical four-part batch helper remains present in the repository and is used by the historical uploader. Temporary bundled entrypoints are removed at the end.

The saved [JSON artifact](upload-pipeline-profile-2026-09-12.json) contains every PUT start/end, file start/completion, publication phase, measured memory peak, source hash, and the full methodology. Measurements below come from that artifact. Each row is one run; differences are observations under these controlled delays, not statistical or production speed claims.

## First PUT and complete selection

| Ciphertext scenario | Historical first PUT | Current first PUT | Historical selection complete | Current selection complete | Peak live part and assembler bytes, both |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 MiB + 1 byte | 58.3 ms | 35.4 ms | 566.8 ms | 554.4 ms | 64 MiB |
| 64 MiB | 63.7 ms | 45.5 ms | 569.8 ms | 550.2 ms | 64 MiB |
| 128 MiB | 95.7 ms | 41.5 ms | 601.1 ms | 544.5 ms | 128 MiB |
| 2,415,919,104 bytes | 89.7 ms | 46.9 ms | 2,305.8 ms | 1,518.0 ms | 192 MiB |

All runs kept at most four PUTs active. The current uploader starts the first ready part without preparing four complete parts first. For the maximum case, part 5 starts at about 117 ms while the slow first part finishes at about 347 ms. The historical uploader starts part 5 at about 453 ms, after its first part finishes at about 390 ms. The script asserts this ordering difference.

At maximum size, unused PUT-slot time between the first PUT start and last PUT completion fell from approximately 5,209 slot-ms to 2,257 slot-ms. This counts every unused slot, including producer work and the final tail; it is not solely a measure of the batch barrier. Measured payload bytes divided by the PUT phase duration were approximately 1,147 MiB/s historically and 1,819 MiB/s currently. These values describe the generated-buffer fixture with delayed in-process adapters, not storage service throughput.

## Mixed selections and conservative memory scheduling

The mixed scenarios contain a 64 MiB ciphertext file followed by 64 KiB and 128 KiB files. The first file has an additional 200 ms publication delay. All configurations advertise a 1 GiB `deviceMemory` hint; the uploader does not use that hint to raise concurrency.

| Hardware concurrency hint | Historical first small file completes | Current first small file completes | Historical total | Current total |
| --- | ---: | ---: | ---: | ---: |
| 2 cores | 611 ms | 390 ms | 612.8 ms | 546.6 ms |
| 1 core | 608 ms | 602 ms | 658.4 ms | 654.5 ms |

With two cores, the current small file completes while the large file still waits for publication. The historical small file waits until the large file is fully published. The script asserts the before/after ordering. Both implementations keep the large file's content buffers exclusive, and both peak at 64 MiB of live part/assembler storage for this fixture.

With one core, the selection scheduler remains serial. This run does not establish a meaningful speed improvement for that configuration. The change preserves the existing conservative limit.

## Memory evidence and limits

All twelve runs completed with a 128 MiB V8 old-space limit. This is a JavaScript heap limit, not a physical 128 MiB or 1 GiB process-memory limit. ArrayBuffers and native digest allocations can live outside that heap.

The harness counts actual live assembler and multipart backing buffers. The maximum case reaches the same 192 MiB ceiling for both implementations: four active parts, one producer part, and one partially assembled part. This includes buffers waiting for presigning/checksum processing and backpressure. It excludes the current plaintext/ciphertext chunk and native SHA-256 copies.

Native sampling captures the allocations omitted by that ownership count. Both maximum-size runs peak at about 260 MiB of ArrayBuffers and 414 MiB RSS. The whole sequential profile peaks at about 415 MiB RSS. These are measurements of this Node process, including runtime and profiling overhead. Allocator-retained memory carries between scenarios despite requested GC, so RSS figures are not independent per-scenario baselines. Sampling occurs at buffer allocation and transfer events and every 10 ms; it can miss shorter native allocation peaks.

The profile verifies that the current uploader releases every tracked part and assembler buffer, preserves the PUT body until its request settles, publishes completion metadata in part order, and refills slots around the delayed first part. Real browser peak RSS, a physically constrained low-memory device, and live network/crypto throughput require separate measurements. The browser acceptance run should be reported separately from these controlled results.
