(() => {
  if (globalThis.auditPreview)
    throw new Error("Preview instrumentation already installed");
  const nativePostMessage = Worker.prototype.postMessage;
  const workers = new Map();
  const pending = new Map();
  const frames = new Set();
  const samples = [];
  const state = {
    startedAt: null,
    firstVisibleTextDomMs: null,
    textAfterTwoFramesMs: null,
    timedOut: false,
    cleaned: false,
    samples,
  };
  let observer;
  let deadline;
  const cleanup = () => {
    if (state.cleaned) return;
    state.cleaned = true;
    if (Worker.prototype.postMessage === observedPostMessage)
      Worker.prototype.postMessage = nativePostMessage;
    observer?.disconnect();
    document.removeEventListener("click", onClick, true);
    clearTimeout(deadline);
    for (const frame of frames) cancelAnimationFrame(frame);
    frames.clear();
    for (const [worker, listener] of workers)
      worker.removeEventListener("message", listener);
    workers.clear();
    pending.clear();
  };
  const onClick = () => {
    state.startedAt = performance.now();
    deadline = setTimeout(() => {
      state.timedOut = true;
      cleanup();
    }, 30000);
  };
  const frame = (callback) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id);
      callback();
    });
    frames.add(id);
  };
  function observedPostMessage(message, ...args) {
    if (state.cleaned)
      return Reflect.apply(nativePostMessage, this, [message, ...args]);
    if (!workers.has(this)) {
      pending.set(this, new Map());
      const listener = (event) => {
        const response = event.data;
        const request = pending.get(this)?.get(response?.id);
        if (!request || (response?.ok && "progress" in response)) return;
        pending.get(this).delete(response.id);
        if (samples.length < 32)
          samples.push({
            type: request.type,
            ciphertextBytes: request.ciphertextBytes,
            durationMs: performance.now() - request.startedAt,
            success: response.ok === true,
          });
      };
      workers.set(this, listener);
      this.addEventListener("message", listener);
    }
    if (
      [
        "startDecryption",
        "decryptChunk",
        "finalizeDecryption",
        "abortDecryption",
      ].includes(message?.type)
    ) {
      pending.get(this).set(message.id, {
        type: message.type,
        ciphertextBytes: message.ciphertext?.byteLength ?? 0,
        startedAt: performance.now(),
      });
    }
    return Reflect.apply(nativePostMessage, this, [message, ...args]);
  }
  state.cleanup = cleanup;
  globalThis.auditPreview = state;
  Worker.prototype.postMessage = observedPostMessage;
  const isMatchingLine = (line) =>
    line?.textContent?.startsWith(
      "Aeralyth performance audit local browser fixture.",
    );
  const hasVisibleLine = () => {
    if (document.visibilityState !== "visible") return false;
    const line = document.querySelector("li code");
    if (!isMatchingLine(line)) return false;
    const rect = line.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    )
      return false;
    for (let element = line; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0 ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    return true;
  };
  const pollVisibility = () => {
    if (state.cleaned) return;
    if (!hasVisibleLine()) {
      frame(pollVisibility);
      return;
    }
    state.firstVisibleTextDomMs = performance.now() - state.startedAt;
    frame(() =>
      frame(() => {
        state.textAfterTwoFramesMs = performance.now() - state.startedAt;
        cleanup();
      }),
    );
  };
  observer = new MutationObserver(() => {
    if (
      state.startedAt === null ||
      !isMatchingLine(document.querySelector("li code"))
    )
      return;
    observer.disconnect();
    pollVisibility();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", onClick, { once: true, capture: true });
  return {
    installed: true,
    storesContentOrKeys: false,
    timing:
      "click to CSS-visible viewport text and two subsequent animation frames; a rendering-opportunity proxy, not a compositor paint measurement",
  };
})();
