# Proton Drive Low-Latency E2EE Architecture
## Research report and implementation blueprint for Aeralyth

**Research date:** August 17, 2026

## Executive conclusion

Proton Drive does not make E2EE fast by somehow making decryption disappear. It makes decryption **rare, cached, batched, parallel, and decoupled from navigation**.

The current Proton Drive TypeScript SDK follows roughly this hot path:

```text
Folder opened
    ↓
get child node IDs
    ↓
check decrypted metadata cache
    ├── fresh cache hit → return immediately
    │
    └── miss/stale
          ↓
       group misses
          ↓
    batch network fetch
          ↓
 decrypt many nodes concurrently
          ↓
  reuse cached parent/node keys
          ↓
 metadata cache + crypto cache
          ↓
       render results

Meanwhile:
remote events → invalidate/update only affected cache entries
```

The important current numbers in Proton's TypeScript SDK are:

| Mechanism | Current SDK behavior |
|---|---:|
| Node metadata API batch capacity | **100 nodes/request** |
| Node-loading batch | **30 nodes** |
| Concurrent node decryptions | **30 in flight** |
| API concurrency across volumes | **15** |
| File upload block size | **4 MiB** |
| Concurrent upload blocks | **5** |
| Buffered upload blocks | **15** |
| Concurrent download blocks/file | **10** |
| Concurrent file downloads | **5** |

These values come directly from the current Proton SDK source.     

The architectural principle matters more than the exact constants. **There is no N-serial-request pipeline for N files.**

That is currently the fundamental difference from Aeralyth.

---

# 1. What Proton changed in 2026

On June 4, 2026, Proton announced that Drive had been rebuilt around the shared Proton Drive SDK, which now supplies the common storage engine behind Drive clients across web, Windows, macOS, iOS, and Android. Proton reports uploads up to 3× faster, downloads up to 2× faster, faster file/photo loading, and smoother large-batch loading.

The public SDK confirms that this shared layer owns folder listing, metadata processing, encryption, downloading, uploading, sharing, and event-based synchronization. Proton explicitly requires appropriate **caching, event-driven synchronization, bounded parallelism, and backoff** and warns against repeated polling or recursive traversal of the remote tree. 

There is one important caveat: Proton currently says another cryptographic-model change is targeted for approximately late 2026/early 2027 to simplify the architecture further while improving performance and security. Therefore this report describes their **current August 2026 production architecture**, not necessarily their final architecture. 

---

# 2. Proton separates metadata navigation from file-content decryption

This distinction is essential.

In Proton's security model, each file/folder is represented by a node. Node keys are protected through the hierarchy: a child's key material is ultimately unlocked through its parent, while filenames are encrypted using parent-folder key material. Actual file contents are stored separately as encrypted blocks.

Conceptually:

```text
Folder key
 ├─ encrypts/unlocks metadata for child A
 ├─ encrypts/unlocks metadata for child B
 ├─ encrypts/unlocks metadata for child C
 └─ ...

File node key
 └─ unlocks file-content key
      └─ encrypted content blocks
```

Consequently, **opening a folder does not decrypt the contents of every file**.

It decrypts comparatively tiny metadata structures such as names and node information.

This is why optimizing AES throughput alone will not solve your folder problem. A few hundred bytes or a few kilobytes of metadata are tiny. Network round trips, repeated key resolution, scheduling, serialization, and rendering easily cost far more than the symmetric decrypt itself.

---

# 3. Proton's actual folder/node loading path

The current public TypeScript implementation is unusually useful here because Proton has exposed the exact architecture.

## 3.1 Cache first

`getNode()` first:

1. waits if somebody else is already loading the same node,
2. attempts to retrieve the node from the metadata cache,
3. returns immediately when the cached node is not stale,
4. only contacts the server when the node is missing or stale. 

This changes the complexity of normal navigation dramatically.

A folder you have already visited is not:

```text
network → decrypt → network → decrypt → ...
```

again.

It is usually:

```text
local cache → UI
```

Proton's cache layer stores **decrypted node metadata**, while explicitly separating it from cryptographic key material. Nodes are indexed by useful tags including their parent UID, volume, root status, and trash status. 

The general SDK cache interface is designed around an indexed local document database and explicitly describes parent-based indexing for rapid lookup. 

This is one of the largest architectural differences from a naïve encrypted cloud drive.

---

# 4. Metadata cache and crypto cache are separate

Proton maintains two conceptually different caches.

### Metadata/entity cache

Contains things such as:

```text
node ID
parent ID
decrypted name
node type
timestamps
revision information
stale state
sharing state
```

The SDK explicitly says this cache should **not contain cryptographic material**. 

### Crypto cache

Separately caches resolved node keys and session-key material needed for subsequent operations. 

The decrypted key object includes things such as the node private key, passphrase session key, content-key session key, and hash key. 

This matters enormously for hierarchical E2EE.

Suppose a folder contains 50 children.

The slow architecture is:

```text
child 1 → discover parent → unlock parent → unlock child
child 2 → discover parent → unlock parent → unlock child
child 3 → discover parent → unlock parent → unlock child
...
```

The Proton architecture becomes approximately:

```text
parent key → cache
                 ├→ child 1
                 ├→ child 2
                 ├→ child 3
                 ├→ child 4
                 └→ ...
```

Repeated navigation becomes substantially cheaper.

---

# 5. Proton batches network requests

This is particularly relevant to Aeralyth.

The node API currently defines:

```ts
const API_CONCURRENCY = 15;
const API_NODES_BATCH_SIZE = 100;
```

and its metadata API accepts arrays of node IDs rather than requiring one HTTP request for every individual node. 

At the higher node-access layer, Proton currently groups uncached nodes into batches of 30. 

Therefore a folder containing 50 uncached nodes is conceptually much closer to:

```text
request containing ~30 nodes
request containing ~20 nodes
```

than:

```text
request node 1
request node 2
request node 3
...
request node 50
```

That distinction alone can turn seconds into a small fraction of a second.

---

# 6. Proton decrypts nodes concurrently

This is probably the most directly applicable piece of Proton's current source.

The current SDK explicitly declares:

```ts
const DECRYPTION_CONCURRENCY = 30;
```

with the accompanying explanation that this is a performance-versus-memory tradeoff. 

Their async iterator starts multiple mapper operations without awaiting each previous operation first. Results are yielded as work completes. 

So this:

```ts
for (const node of nodes) {
    await decrypt(node);
}
```

is explicitly **not** Proton's strategy.

It is much more similar to:

```ts
await mapWithConcurrency(nodes, 30, decrypt);
```

Thirty here means 30 in-flight asynchronous node-decryption operations, not necessarily 30 JavaScript CPU threads.

---

# 7. Proton prevents duplicate work

The SDK has a dedicated `NodesDebouncer`.

Its purpose is explicitly to prevent the same node from being loaded twice concurrently. If another operation already has node X in flight, callers wait for that existing operation instead of performing another network/decryption chain. 

Conceptually:

```ts
Map<NodeId, Promise<Node>>
```

rather than:

```text
Caller A → fetch X
Caller B → fetch X again
Caller C → fetch X again
```

This pattern is often called:

- single-flight
- request coalescing
- promise deduplication

Aeralyth should have this around node opening.

---

# 8. Proton keeps the cache fresh with events

A cache is not useful if every navigation must revalidate every entry individually.

Proton therefore couples its cache architecture to Drive events.

Current SDK event handling can:

- mark nodes stale,
- update parent relationships,
- update trash/share state,
- remove deleted nodes,
- invalidate an entire volume only when a tree refresh requires it. 

The main SDK client explicitly wires Drive events into its internal cache-maintenance handlers. 

This allows the fundamental strategy:

```text
Assume cached data remains useful
UNTIL an event tells you otherwise.
```

rather than:

```text
Assume all local data may be wrong
and re-fetch everything whenever the user clicks.
```

For a Drive application, this is a massive latency difference.

---

# 9. Proton's private content-access path

Proton also separates the metadata/control plane from the encrypted-content data plane.

For downloads, the Drive API supplies block metadata including a storage URL plus an authorization token. The client then directly retrieves the encrypted block stream using those credentials. 

This is architecturally analogous to Aeralyth's private S3 + short-lived presigned URL model:

```text
Authenticated application API
        ↓
authorizes object access
        ↓
short-lived capability / URL / token
        ↓
client ↔ encrypted object storage
```

The backend does not need to proxy the file bytes through the application server.

For Aeralyth, **your existing private-object-storage/presigning model is fundamentally the right direction**.

Folder metadata and file-content access simply should not share the same latency path.

---

# 10. Proton's bulk transfer pipeline

Folder-navigation performance and transfer performance are separate problems.

For actual file transfers, Proton heavily pipelines work.

## Upload

Current TypeScript SDK:

```text
read 4 MiB plaintext block
       ↓
encrypt
       ↓
buffer encrypted block
       ↓
upload
```

Encryption and upload overlap rather than waiting for the entire file to encrypt first. The current implementation allows 15 encrypted blocks buffered and 5 blocks uploading concurrently. 

It also has a special small-file path that can avoid the full streaming/multipart machinery for suitable files. 

## Download

For a file, Proton currently allows up to 10 encrypted blocks to download concurrently, decrypts them, buffers completed blocks, and writes them to the output stream in correct order. 

Across files, the SDK currently caps concurrent downloads at five to control memory and rate limiting. 

This is another recurring Proton principle:

> **Bound everything, but pipeline everything.**

---

# 11. Hardware-accelerated file encryption

Proton's June 2026 cryptographic update moved new file contents to the newer OpenPGP construction using v6 PKESK and v2 SEIPD with AES-GCM.

AES-GCM can use hardware cryptographic acceleration available on modern processors. Proton reports file encryption/decryption improvements of up to roughly 4× in its benchmarks.

This is important for:

- large uploads,
- downloads,
- battery use,
- CPU utilization,
- heat.

But it is **not the main explanation for your 2-second folder-list problem**.

Your folder metadata is small enough that architecture overwhelms raw cipher throughput.

---

# 12. What Aeralyth currently does

Now to the important part.

Your current `VaultFileList` contains essentially:

```ts
for (const entry of entries) {
    ...
    const manifest = await vault.openNode(entry.id);
    ...
}
```

It deliberately avoids unbounded fan-out and publishes resolution progress in batches of 24, but the actual `openNode()` calls remain serial. 

That means:

```text
node 1 must completely finish
before node 2 begins

node 2 must completely finish
before node 3 begins

...
```

This would already be unnecessarily slow.

But there is a much larger problem.

---

# 13. Aeralyth currently performs a network request inside every `openNode()`

Your current provider does this:

```ts
const nodePlan =
    plan ?? (await getVaultDownloadPlan(nodeId, signal));

return (await client.openPlan(nodePlan)).manifest;
```

and only if the required parent is missing does it recursively open the parent and retry. 

`getVaultDownloadPlan()` performs:

```text
GET /api/vault/nodes/{id}/download-plan
```

and `vaultRequest()` explicitly uses:

```ts
cache: "no-store"
```

so these are real application requests rather than something that can conveniently fall into HTTP browser caching. 

Your backend exposes exactly one `download-plan` route per node. 

Therefore your current folder path is effectively:

```text
Folder response
    ↓
child 1
    GET download-plan
    worker openPlan
    wait
    ↓
child 2
    GET download-plan
    worker openPlan
    wait
    ↓
child 3
    GET download-plan
    worker openPlan
    wait
    ↓
...
```

Your default folder page contains **50 entries**, with a maximum page size of 100. 

So even modest per-request latency compounds into seconds.

This is almost certainly the primary source of the behavior you described.

---

# 14. The UI batching currently only disguises the problem

`METADATA_PROGRESS_BATCH_SIZE = 24` reduces React updates, which is good.

But the loop intentionally publishes:

```text
first decrypted node
then after 24
then after another 24
...
```

while continuing to decrypt sequentially. 

Therefore the user visibly observes:

```text
encrypted/skeleton name
↓
one name appears
↓
more names eventually appear
↓
folder finally looks complete
```

That is exactly the UX you described.

React rendering is not the underlying cause here.

The serial asynchronous dependency chain is.

---

# 15. Aeralyth already has several correct foundations

I would **not** redesign the entire cryptographic system.

You already have several good pieces.

Your vault runs in a dedicated Web Worker, so crypto does not directly monopolize the React main thread. The worker also already holds an in-memory `nodeKeys` map, meaning resolved node keys can be reused while the vault remains unlocked. 

You also already have:

```ts
mapWithConcurrency(...)
detectedCryptoConcurrency(...)
WeightedSemaphore
BoundedBatchPipeline
```

implemented in `bounded-async.ts`. 

So the machinery required for a Proton-like implementation is already present.

It simply is not being used in the folder metadata path.

---

# 16. Highest-priority Aeralyth redesign

I would implement this architecture.

```text
                     ┌──────────────────────────────┐
                     │ Local decrypted metadata    │
                     │ cache / revision cache      │
                     └──────────────┬───────────────┘
                                    │
Folder clicked ─────────────────────┼── cache hits → render
                                    │
                                    ▼
                         identify cache misses
                                    │
                                    ▼
                      ONE metadata-plan request
                           for whole page
                                    │
                                    ▼
                       Web Worker batch request
                                    │
                          resolve parent once
                                    │
                    ┌───────────────┴──────────────┐
                    │ bounded parallel decryption │
                    │    e.g. 16–30 in flight     │
                    └───────────────┬──────────────┘
                                    │
                                    ▼
                         one/batched UI commit
                                    │
                                    ▼
                        update metadata cache
```

The most important requirement is:

> **A folder containing N children must never generate N sequential API requests.**

---

# 17. Create a metadata-specific batch API

Do not reuse a full content `download-plan` unnecessarily.

Folder navigation does not need:

- file ciphertext,
- download URLs,
- content chunk information,
- S3 access capabilities.

It only needs enough encrypted material to authenticate and decrypt node metadata.

Create something conceptually like:

```http
POST /api/vault/nodes/metadata-plans
```

```json
{
  "nodeIds": [
    "...",
    "...",
    "..."
  ]
}
```

returning all metadata plans in one response.

Even better, because `/api/files` already knows exactly which 50-100 entries are being listed, optionally include the required encrypted metadata-plan material directly in the folder-list response.

Then cold folder opening becomes:

```text
1 listing request
+
0 or 1 metadata request
+
parallel local decryption
```

instead of:

```text
1 listing request
+
N download-plan requests
+
N serial decryptions
```

This is probably the single largest performance improvement available to Aeralyth today.

---

# 18. Add `VaultMetadataPlan`

I recommend separating your protocol types:

```ts
VaultMetadataPlan
VaultDownloadPlan
```

rather than making folder listing depend on `VaultDownloadPlan`.

For example:

```ts
type VaultMetadataPlan = {
    nodeId: string;
    parentId: string | null;

    recordVersion: number;
    recordHash: string;
    generationId?: string;

    bootstrapCbor: ArrayBuffer;
    bootstrapSignature: ArrayBuffer;
    encryptedManifest: ArrayBuffer;

    wrappers: ...;
    signer: ...;
};
```

Only actual download should then add:

```text
ciphertext location
generation data
chunk information
presigned capability
Merkle information needed for content
```

This makes folder responses smaller and prevents storage authorization from being needlessly generated just to display filenames.

---

# 19. Batch the worker API too

Instead of sending:

```text
postMessage openPlan
await
postMessage openPlan
await
postMessage openPlan
await
```

add:

```ts
openMetadataPlans(
    plans: VaultMetadataPlan[],
    concurrency: number,
)
```

to the worker protocol.

Inside the worker:

```ts
const results = await mapWithConcurrency(
    plans,
    metadataConcurrency,
    openMetadataPlan,
);
```

You already have the implementation of `mapWithConcurrency`. 

I would benchmark:

```text
8
16
24
30
```

in-flight metadata operations.

Proton currently uses 30 for its TypeScript node decryptions. 

I would not blindly hardcode Proton's value. Your HPKE/AES/CBOR/key hierarchy is different.

But **16 is a much better starting point than 1**.

---

# 20. Resolve the parent once

Sibling nodes have the same parent.

Take advantage of that explicitly.

Before processing a folder batch:

```ts
const parentKey = await resolveNodeKey(parentId);
```

Then pass/use that cached parent context for every child.

Do not allow 30 concurrent children to independently discover:

```text
"I need parent X"
```

and then all start opening parent X.

Proton solves the general duplicate-work problem with its `NodesDebouncer`. 

Aeralyth should implement equivalent single-flight behavior:

```ts
const inFlightNodeOpens =
    new Map<string, Promise<OpenedPlan>>();
```

Then:

```ts
function openNodeSingleFlight(id: string) {
    const existing = inFlightNodeOpens.get(id);
    if (existing) return existing;

    const operation = reallyOpenNode(id)
        .finally(() => inFlightNodeOpens.delete(id));

    inFlightNodeOpens.set(id, operation);
    return operation;
}
```

---

# 21. Add a real metadata cache

For a Proton-class UX, batching alone is not sufficient.

Cold navigation gets fast from batching.

**Warm navigation gets instant from caching.**

I recommend:

```text
L1: worker-memory key cache
L2: application-memory decrypted metadata cache
L3: optional encrypted persistent metadata cache in IndexedDB
```

A metadata cache item might be:

```ts
{
    nodeId,
    parentId,
    recordHash,
    generationId,
    name,
    mimeType,
    entryType,
    plaintextBytes
}
```

A cache entry is valid when its cryptographic revision identifiers still match the server listing.

---

# 22. Do not use `updatedAt` as your primary cryptographic cache version

Your current React cache effectively validates resolved metadata using:

```ts
sourceUpdatedAt === entry.updatedAt
```



You already have stronger information elsewhere in your backend.

`FolderArchiveEntry` contains:

```text
vault_generation_id
vault_record_hash
```

while your regular `FileEntry` currently does not expose those values. 

I would add at least:

```ts
vaultRecordHash
vaultRecordVersion
vaultGenerationId
```

to encrypted `FileEntry`s.

Then:

```text
cached.recordHash === entry.vaultRecordHash
```

is a precise determination that the cached decrypted metadata corresponds to the current encrypted record.

This prevents needless re-decryption caused by unrelated timestamp updates.

---

# 23. Persistent metadata caching without sacrificing your threat model

There is a security tradeoff here.

Persisting:

```text
"Tax Documents"
"Photos"
"passwords.txt"
```

as plaintext IndexedDB entries would preserve server-side E2EE but weaken local-at-rest privacy.

You do not need to do that.

A stronger Aeralyth design would be:

```text
vault root key
     ↓ HKDF
device metadata-cache key
     ↓
AES-GCM encrypted IndexedDB metadata
```

The IndexedDB index can contain only non-secret validators such as:

```text
nodeId
recordHash
```

If you want to hide even local hierarchy metadata, derive an indexed parent token:

```text
HMAC(cacheIndexKey, parentId)
```

After vault unlock:

```text
derive cache key
↓
query local child index
↓
decrypt small local cache records in parallel
↓
render
```

This keeps persistent cache useful without casually leaving filenames in browser storage.

When locked:

```text
wipe root key
wipe cache key
wipe worker node-key cache
wipe decrypted in-memory cache
```

Your worker already has a centralized lock lifecycle and key maps, making this relatively clean to implement. 

---

# 24. Make navigation cache-first and synchronization event-driven

The ideal mature Aeralyth architecture is not:

```text
click folder
↓
ask server what exists
↓
decrypt everything
↓
render
```

It is:

```text
click folder
↓
read local node DB
↓
render immediately

background:
server change cursor/events
↓
update/invalidate local node DB
```

This is the Proton pattern. Their event subsystem marks precisely affected cache entries stale or removes them, while retaining unaffected nodes. 

For Aeralyth, implement an append-only change stream conceptually like:

```json
{
  "cursor": 839201,
  "events": [
    {
      "type": "nodeUpdated",
      "nodeId": "...",
      "parentId": "...",
      "recordHash": "..."
    }
  ]
}
```

The transport can eventually be:

```text
long polling
SSE
WebSocket
```

The important property is the **cursor/event model**, not the transport.

Do not recursively crawl the full tree to maintain freshness. Proton explicitly discourages that architecture. 

---

# 25. Fix the visible decryption waterfall

Even after making the underlying architecture fast, change the presentation behavior.

Current behavior exposes resolution progress after the first node. 

For a 50-row folder, instead do:

```text
cached rows → immediate

cold first viewport:
decrypt 20-30 concurrently
↓
single React commit
↓
remaining page resolves in background
```

Do not render:

```text
File 1
[encrypted]
[encrypted]
[encrypted]

then

File 1
File 2
[encrypted]
[encrypted]
```

unless there is genuinely a long operation.

For ordinary folder listing, the user should see either:

```text
cached complete list
```

or briefly:

```text
stable skeleton/list placeholder
```

followed by:

```text
complete first viewport
```

This removes the visual feeling that the encryption engine is struggling.

---

# 26. Prefetch navigation intelligently

Once the fundamental architecture is fixed, prefetch is cheap icing.

On:

```text
pointerenter
focus
pointerdown
```

of a folder row, you can begin loading:

```text
child IDs/listing
metadata plans
```

for that folder.

If the user clicks 100-300 ms later, much of the cold path may already have completed.

Do **not** recursively prefetch every subtree.

Only prefetch high-probability immediate navigation targets.

---

# 27. Recommended Aeralyth execution pipeline

The final desired cold-folder path should resemble:

```ts
async function openFolder(folderId: string, signal: AbortSignal) {
    // 1. Local cache first
    const cached = await metadataCache.children(folderId);

    if (cached.completeAndFresh) {
        render(cached.entries);
        void revalidateInBackground(folderId);
        return;
    }

    // 2. One server listing
    const listing = await getFolderListing(folderId, signal);

    // 3. Reuse everything whose cryptographic version matches
    const { hits, misses } =
        await metadataCache.resolveAgainst(listing.entries);

    renderCacheHitsImmediately(hits);

    // 4. One batch request, not N requests
    const plans =
        await getMetadataPlans(misses.map(x => x.id), signal);

    // 5. One worker command, bounded parallel decryption
    const resolved =
        await vault.openMetadataPlans(plans, {
            concurrency: 16,
            signal,
        });

    // 6. One commit for the visible batch
    commitResolvedMetadata(resolved);

    // 7. Cache for subsequent navigation
    await metadataCache.put(resolved);
}
```

Eventually, with event synchronization, step 2 does not necessarily need to block warm navigation either.

---

# 28. What I would change first in your repository

### P0: Fix immediately

1. Replace the serial `for ... await vault.openNode()` folder-list loop.
2. Add batch metadata-plan retrieval.
3. Add `openMetadataPlans()` to the worker protocol.
4. Use your existing `mapWithConcurrency()`.
5. Pre-resolve/cache the current parent key.
6. Add single-flight node loading.
7. Commit resolved first-viewport metadata atomically.

These changes attack the current 2-second problem directly.

### P1: Proton-class warm navigation

1. Add decrypted metadata memory cache.
2. Version cache using `recordHash`/`recordVersion`, not merely `updatedAt`.
3. Build an indexed `parentId → children` local cache.
4. Add encrypted IndexedDB persistence if desired.
5. Add incremental event/cursor synchronization.
6. Use stale-while-revalidate navigation.

### P2: Polish

1. Folder-hover/pointer-down prefetch.
2. Adaptive concurrency.
3. viewport prioritization.
4. cancellation of abandoned navigation.
5. virtualization if directories become extremely large.
6. detailed latency telemetry.

---

# 29. Performance targets I would set

These are recommended Aeralyth engineering targets, **not claimed Proton numbers**.

| Scenario | Target |
|---|---:|
| Warm cached folder navigation | <50 ms p95 |
| UI reaction to click | <16 ms |
| Cold metadata network operations | O(1) requests/page |
| First visible cold-folder rows | <200-300 ms p95 on ordinary network |
| Warm cache hit ratio after normal browsing | >90% |
| Duplicate node fetches | 0 |
| Sequential per-node HTTP requests | 0 |
| Main-thread long tasks during metadata decryption | 0 |
| Full-subtree refresh during ordinary navigation | 0 |

The most important invariant is not an exact millisecond figure:

```text
Folder-open latency must NOT scale linearly with
(number of children × network round-trip latency).
```

---

# 30. Instrument before and after

Add Performance API spans around:

```text
folder_click
folder_listing_start
folder_listing_response

metadata_cache_lookup_start/end
metadata_cache_hits
metadata_cache_misses

metadata_batch_request_start/end

worker_batch_start
parent_key_resolution
node_decrypt_start/end
worker_batch_end

first_viewport_ready
full_page_ready

react_commit
```

Then collect:

```text
p50
p95
p99
```

against:

```text
folder child count
cache hit rate
browser
CPU
network RTT
```

Do not record filenames or plaintext metadata in telemetry.

This will immediately tell you whether remaining latency is:

```text
network
backend
worker scheduling
crypto
cache I/O
React
```

instead of treating it generically as "decryption time."

---

# 31. What not to optimize first

I would **not** begin by:

- replacing AES-GCM,
- rewriting the vault in Rust/WASM,
- increasing worker count,
- weakening your encryption,
- decrypting metadata server-side,
- creating gigantic `Promise.all()` calls,
- recursively warming the complete vault tree.

Your current architecture already has strong cryptographic primitives and a Web Worker.

The giant architectural red flag is far simpler:

```ts
for each visible encrypted node
    await network
    await crypto
```

Fix that first.

---

# 32. Proton pattern translated directly to Aeralyth

| Proton pattern | Aeralyth equivalent |
|---|---|
| Batched node metadata API | Batch `VaultMetadataPlan` API |
| 30 node load batch | 20-50 metadata plan batch |
| 30 concurrent decryptions | bounded worker metadata decryptions |
| Decrypted node cache | decrypted manifest/name cache |
| Separate crypto cache | existing worker `nodeKeys` cache |
| Node debouncer | `Map<NodeId, Promise<...>>` |
| Parent-key reuse | resolve folder parent key once |
| Event-driven invalidation | Aeralyth node-change cursor |
| Parent UID indexed cache | indexed folder child cache |
| Cache freshness/stale flag | `recordHash` validation |
| 4 MiB block pipeline | your existing chunked content crypto |
| Tokenized direct block access | private S3 presigned URLs |
| Overlap encryption/upload | bounded producer-consumer upload pipeline |

You are already surprisingly close on the content-transfer side.

The biggest missing piece is the **metadata access layer**.

---

# 33. Short implementation brief for a Programming AI

> Refactor Aeralyth's encrypted folder-listing hot path so that folder navigation never performs one sequential `/api/vault/nodes/{id}/download-plan` request per child. Introduce a metadata-only batch plan API supporting at least the existing 100-entry page maximum, or include metadata plans directly in `/api/files`. Add `vault.openMetadataPlans()` as a single Worker RPC and use the existing `mapWithConcurrency()` helper to decrypt metadata with bounded concurrency, initially benchmarked at 8/16/24/30. Resolve the current folder's parent key once and add single-flight deduplication for node/key loads. Cache decrypted node metadata independently from key material and validate it using `vaultRecordHash`/`recordVersion` rather than `updatedAt`; expose these identifiers on encrypted `FileEntry`s. Render cache hits immediately and cold first-viewport results atomically rather than publishing the first decrypted row and then batches. Longer term, maintain an indexed local node database keyed by parent and keep it fresh through an incremental event cursor so warm folder navigation is entirely cache-first. Preserve all existing E2EE guarantees: the server must never receive plaintext names, metadata, node keys, or content keys, and content storage remains privately accessed through short-lived presigned capabilities.

---

# Final assessment

Your present problem can be summarized as:

```text
Aeralyth today
==============

50 children
   ↓
~50 serial metadata HTTP operations
   ↓
~50 serial open/decrypt operations
   ↓
progressive React updates
   ↓
visible ~seconds-scale latency
```

The architecture you want is:

```text
Aeralyth target
===============

50 children
   ↓
local cache hits ───────────────→ immediate
   ↓ misses
1 batch metadata request
   ↓
parent key resolved once
   ↓
16–30 bounded concurrent decryptions
   ↓
one first-viewport commit
   ↓
cache results
```

And eventually:

```text
warm folder click
      ↓
indexed local metadata cache
      ↓
render

          background event synchronization
                       ↑
                    server
```

That is the central lesson from Proton's current architecture.

**Do not try to make serial E2EE faster. Remove serial work from the critical path.**

Proton's 2026 cryptographic improvements are excellent for file throughput, but its low-latency UI comes from the broader system design: **cache-first reads, batched metadata transport, bounded parallel decryption, key reuse, single-flight loading, event-driven invalidation, and pipelined content transfers.**