import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  instantiateRawDeflater,
  nativeDeflateRaw,
  storedDeflateBlocks,
  storedDeflateSize,
  verifyRawDeflater,
} from "@/features/archive/raw-deflate";

// The exact module that `npm run worker:build` publishes as ZIP_WASM_URL.
const wasm = readFile(
  fileURLToPath(import.meta.resolve("@zip.js/zip.js/dist/zip-module.wasm")),
);

function text(length: number) {
  const words = ["const", "value", "return", "archive", "entry", "=>", "{}"];
  let output = "";
  for (let index = 0; output.length < length; index++) {
    output += `${words[(index * 7) % words.length]} ${index % 97} `;
  }
  return new TextEncoder().encode(output.slice(0, length));
}

function random(length: number) {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
  }
  return bytes;
}

describe("raw deflate on the zip.js zlib module", () => {
  it.each([0, 1, 10, 4096, 300_000, 3_000_000])(
    "produces a complete deflate stream for %i bytes",
    async (length) => {
      const deflater = await instantiateRawDeflater(await wasm);
      const input = text(length);
      for (const level of [1, 6]) {
        const output = deflater.deflateRaw(input, level, true);
        expect(inflateRawSync(output).equals(input)).toBe(true);
      }
    },
  );

  it("compresses like zlib at the same level", async () => {
    const deflater = await instantiateRawDeflater(await wasm);
    const input = text(500_000);
    for (const level of [1, 6]) {
      const expected = deflateRawSync(input, { level }).length;
      const actual = deflater.deflateRaw(input, level, true).length;
      expect(Math.abs(actual - expected)).toBeLessThan(expected * 0.02);
    }
  });

  it("keeps incompressible input within the stored-block bound", async () => {
    const deflater = await instantiateRawDeflater(await wasm);
    const input = random(1_000_000);
    const output = deflater.deflateRaw(input, 1, true);
    expect(output.length).toBeLessThan(input.length * 1.01);
    expect(inflateRawSync(output).equals(input)).toBe(true);
  });

  it("concatenates sync-flushed, stored and final ranges into one stream", async () => {
    const deflater = await instantiateRawDeflater(await wasm);
    const input = text(900_000);
    const noise = random(200_000);
    const parts = [
      deflater.deflateRaw(input.subarray(0, 300_000), 1, false).slice(),
      storedDeflateBlocks(noise, false),
      deflater.deflateRaw(new Uint8Array(0), 1, false).slice(),
      deflater.deflateRaw(input.subarray(300_000, 600_001), 1, false).slice(),
      storedDeflateBlocks(new Uint8Array(0), false),
      deflater.deflateRaw(input.subarray(600_001), 1, true).slice(),
    ];
    expect(
      inflateRawSync(Buffer.concat(parts)).equals(
        Buffer.concat([
          input.subarray(0, 300_000),
          noise,
          input.subarray(300_000),
        ]),
      ),
    ).toBe(true);
  });

  it("does not leak module memory across many streams", async () => {
    const deflater = await instantiateRawDeflater(await wasm);
    const input = text(20_000);
    const first = deflater.deflateRaw(input, 1, true).slice();
    for (let index = 0; index < 5_000; index++) {
      deflater.deflateRaw(input, 1, index % 2 === 0);
    }
    // The module's memory cannot grow, so a leak would exhaust it by now.
    expect(deflater.deflateRaw(input, 1, true)).toEqual(first);
  });

  it("passes its own round-trip check", async () => {
    const deflater = await instantiateRawDeflater(await wasm);
    expect(await verifyRawDeflater(deflater)).toBe(true);
    expect(
      await verifyRawDeflater({
        deflateRaw: (input) => input.slice(),
      }),
    ).toBe(false);
  });

  it("rejects a module without the raw deflate exports", async () => {
    // The smallest valid module: magic number and version only.
    const empty = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
    await expect(instantiateRawDeflater(empty)).rejects.toThrow(
      "does not provide raw deflate",
    );
  });
});

describe("stored deflate blocks", () => {
  it.each([0, 1, 65_535, 65_536, 200_000])(
    "wraps %i bytes as a final stream",
    (length) => {
      const input = random(length);
      const output = storedDeflateBlocks(input, true);
      expect(output.length).toBe(storedDeflateSize(length, true));
      expect(inflateRawSync(output).equals(input)).toBe(true);
    },
  );

  it("emits nothing for an empty non-final range", () => {
    expect(storedDeflateBlocks(new Uint8Array(0), false).length).toBe(0);
    expect(storedDeflateSize(0, false)).toBe(0);
    expect(storedDeflateSize(65_535, false)).toBe(65_540);
    expect(storedDeflateSize(65_536, false)).toBe(65_546);
  });
});

describe("native raw deflate", () => {
  it("round-trips through CompressionStream", async () => {
    const input = text(100_000);
    const output = await nativeDeflateRaw(input);
    expect(output.length).toBeLessThan(input.length / 2);
    expect(inflateRawSync(output).equals(input)).toBe(true);
  });
});
