import assert from "node:assert/strict";

// A replay or wake can emit an empty checkpoint before the requested change.
// Keep one absolute deadline while skipping those valid control frames.
export async function nextFixtureChanges(
  stream,
  deadline = performance.now() + 5_000,
) {
  for (;;) {
    assert.ok(performance.now() < deadline, "change event deadline exceeded");
    const frame = await stream.next(deadline);
    if (frame.event === "checkpoint") {
      assert.deepEqual(JSON.parse(frame.data), {});
      continue;
    }
    assert.equal(frame.event, "changes");
    return frame;
  }
}

// Keep the reader so cleanup can cancel a pending read directly. Node 22 can
// lose fetch's internal abort listener after garbage collection of its Request.
export function createFixtureStream({
  url,
  headers,
  timeoutMs,
  onFrame,
  onError,
}) {
  const controller = new AbortController();
  const firstFrame = Promise.withResolvers();
  let reader;
  let closed = false;
  let closing;
  let cancellation;
  const timeout = setTimeout(() => {
    firstFrame.reject(new Error("fixture SSE initial frame timed out"));
    controller.abort();
    cancelReader();
  }, timeoutMs);
  const stream = {
    lastFrameAt: performance.now(),
    ready: firstFrame.promise,
    close,
  };
  // Setup may still be registering the other fixture resources.
  firstFrame.promise.catch(() => {});
  const task = (async () => {
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      reader = response.body?.getReader();
      if (closed || controller.signal.aborted) return;
      assert.equal(response.status, 200, "SSE must authenticate successfully");
      assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
      );
      assert.ok(reader, "SSE response has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const frame = buffer.slice(0, end);
          assert.ok(
            !frame.includes("event: session-expired"),
            "fixture session expired",
          );
          stream.lastFrameAt = performance.now();
          onFrame();
          firstFrame.resolve();
          clearTimeout(timeout);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
        }
        assert.ok(buffer.length < 1024 * 1024, "unbounded SSE frame");
      }
      if (!closed) throw new Error("SSE ended before workload completion");
    } catch (error) {
      firstFrame.reject(error);
      if (!closed) onError(error);
    } finally {
      clearTimeout(timeout);
      try {
        await cancelReader();
      } finally {
        reader?.releaseLock();
        reader = undefined;
      }
    }
  })();
  task.catch((error) => {
    firstFrame.reject(error);
    if (!closed) onError(error);
  });

  function cancelReader() {
    if (reader && !cancellation) {
      cancellation = reader.cancel().catch((error) => {
        // A fetch abort may already have errored its body. Other cancellation
        // failures must remain visible to the fixture cleanup gate.
        if (error?.name !== "AbortError") throw error;
      });
      cancellation.catch(() => {});
    }
    return cancellation;
  }

  function close(cleanupTimeoutMs) {
    if (closing) return closing;
    closed = true;
    firstFrame.reject(new Error("fixture SSE closed before its first frame"));
    controller.abort();
    // Aborting may already have errored the body. Explicit cancellation still
    // releases pending reads when abort propagation itself was lost.
    cancelReader();
    closing = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.all([task, cancellation]),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("fixture SSE cleanup timed out")),
              cleanupTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  }
  return stream;
}
