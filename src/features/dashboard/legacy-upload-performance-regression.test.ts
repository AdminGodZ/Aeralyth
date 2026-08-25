import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy upload performance wiring", () => {
  it("uses one bounded file scheduler and one shared multipart semaphore", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "upload-panel.tsx"),
      "utf8",
    );

    expect(source).toContain("scheduleLegacyUploads(");
    expect(source).toContain("new WeightedSemaphore(MULTIPART_CONCURRENCY)");
    expect(source).toContain("multipartSlots.acquire(1, signal)");
    expect(source).toContain("signal.aborted || !completionStarted");
    expect(source).not.toContain("Legacy uploads are deliberately serialized");
  });

  it("routes Blob checksums through the generated incremental worker", () => {
    const panelSource = readFileSync(
      resolve(import.meta.dirname, "upload-panel.tsx"),
      "utf8",
    );
    const clientSource = readFileSync(
      resolve(import.meta.dirname, "upload-checksum-client.ts"),
      "utf8",
    );
    const packageSource = readFileSync(
      resolve(import.meta.dirname, "../../../package.json"),
      "utf8",
    );

    expect(panelSource).toContain("sha256BlobBase64(blob, signal)");
    expect(panelSource).toContain("sha256BlobBase64(selection.file, signal)");
    expect(panelSource).not.toContain("await blob.arrayBuffer()");
    expect(clientSource).toContain("UPLOAD_CHECKSUM_WORKER_URL");
    expect(packageSource).toContain('"worker:checksum"');
  });

  it("coalesces progress and can refresh both single and multipart signatures", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "upload-panel.tsx"),
      "utf8",
    );

    expect(source).toContain("createAnimationFrameProgressCoalescer(");
    expect(source).toContain("runUploadWithRetry({");
    expect(source).toContain("await waitForUploadRetry(delayMs, signal)");
    expect(source).toContain('compressionMode: "speed"');
    expect(source).toContain("}/parts/");
    expect(source).toContain("/content-url");
    expect(source).not.toContain("uploadedByPart.set(key, loaded)");
    expect(source).not.toContain("function wait(milliseconds");
  });
});
