import { describe, expect, it } from "vitest";

import { archiveCompressionLevel } from "@/features/archive/compression-policy";

describe("ZIP compression policy", () => {
  it.each([
    ["photo.JPG", "image/jpeg"],
    ["archive.zip", "application/zip"],
    ["movie.bin", "video/mp4"],
    ["encrypted.bin", "application/octet-stream"],
    ["font.woff2", "font/woff2"],
  ])("stores known incompressible content: %s", (path, mimeType) => {
    expect(archiveCompressionLevel({ path, mimeType })).toBe(0);
  });

  it("keeps balanced text compression and exposes a speed-first mode", () => {
    expect(
      archiveCompressionLevel({ path: "src/index.ts", mimeType: "text/plain" }),
    ).toBe(6);
    expect(
      archiveCompressionLevel({
        path: "src/index.ts",
        mimeType: "text/plain",
        mode: "speed",
      }),
    ).toBe(1);
    expect(
      archiveCompressionLevel({
        path: "diagram.svg",
        mimeType: "image/svg+xml",
      }),
    ).toBe(6);
  });
});
