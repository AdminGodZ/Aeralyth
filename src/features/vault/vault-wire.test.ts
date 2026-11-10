import { describe, expect, it } from "vitest";

import {
  encodeCreateSharePublication,
  encodeFolderBatchPublication,
  encodeInlineUploadBatch,
  encodeNodePublication,
  encodePublishEpochPublication,
  encodeShareDirectoryPublication,
} from "@/features/vault/vault-wire";

describe("vault binary publication wire", () => {
  it("matches the backend's stable version-1 node fixture", () => {
    const encoded = encodeNodePublication(
      [{ partNumber: 7, etag: "e", checksumSha256: "c" }],
      {
        bootstrapCbor: new Uint8Array([1, 2]),
        bootstrapSignature: new Uint8Array(64).fill(3),
        encryptedManifest: new Uint8Array([4, 5, 6]),
        wrappers: [new Uint8Array([7, 8])],
      },
    );

    const expectedHex =
      "41564c540101000000000001000000070000000165000000016300000002010200000040" +
      "03".repeat(64) +
      "0000000304050600000001000000020708";
    expect(Buffer.from(encoded).toString("hex")).toBe(expectedHex);
  });

  it("matches the backend's inline upload batch fixture", () => {
    const record = (marker: number) => ({
      bootstrapCbor: new Uint8Array([marker, marker + 1]),
      bootstrapSignature: new Uint8Array(64).fill(marker + 2),
      encryptedManifest: new Uint8Array(16).fill(marker + 3),
      wrappers: [new Uint8Array([marker + 4, marker + 5])],
    });
    const encoded = encodeInlineUploadBatch([
      {
        parentId: "fil_parent",
        chunkCount: 1,
        record: record(1),
        content: new Uint8Array(3).fill(7),
      },
      {
        parentId: null,
        chunkCount: 1,
        record: record(2),
        content: new Uint8Array(3).fill(8),
      },
    ]);

    const item = (parent: string, marker: number) =>
      `${parent}0000000100000002${hex(marker)}${hex(marker + 1)}00000040` +
      hex(marker + 2).repeat(64) +
      `00000010${hex(marker + 3).repeat(16)}0000000100000002` +
      `${hex(marker + 4)}${hex(marker + 5)}00000003${hex(marker + 6).repeat(3)}`;
    expect(Buffer.from(encoded).toString("hex")).toBe(
      "41564c540106000000000002" +
        item(`0000000a${Buffer.from("fil_parent").toString("hex")}`, 1) +
        item("ffffffff", 2),
    );
  });

  it("bounds inline upload batches like the backend decoder", () => {
    const upload = {
      parentId: null,
      chunkCount: 1,
      record: {
        bootstrapCbor: new Uint8Array(1),
        bootstrapSignature: new Uint8Array(64),
        encryptedManifest: new Uint8Array(1),
        wrappers: [new Uint8Array(1)],
      },
      content: new Uint8Array(1),
    };
    expect(() => encodeInlineUploadBatch([])).toThrow();
    expect(() =>
      encodeInlineUploadBatch(Array.from({ length: 65 }, () => upload)),
    ).toThrow();
    expect(() =>
      encodeInlineUploadBatch([
        { ...upload, content: new Uint8Array(2 * 1024 * 1024 + 1) },
      ]),
    ).toThrow();
  });

  it("uses raw byte strings without base64 expansion", () => {
    const wrapper = new Uint8Array(65_536).fill(7);
    const binary = encodeNodePublication([], {
      bootstrapCbor: new Uint8Array([1, 2, 3]),
      bootstrapSignature: new Uint8Array(64),
      encryptedManifest: new Uint8Array(1_024),
      wrappers: [wrapper],
    });
    const json = JSON.stringify({
      bootstrapCbor: Buffer.from([1, 2, 3]).toString("base64url"),
      bootstrapSignature: Buffer.alloc(64).toString("base64url"),
      encryptedManifest: Buffer.alloc(1_024).toString("base64url"),
      wrappers: [Buffer.from(wrapper).toString("base64url")],
      parts: [],
    });

    expect(binary.byteLength).toBe(66_659);
    expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(
      binary.byteLength * 1.32,
    );
    expect([...binary.subarray(0, 8)]).toEqual([
      0x41, 0x56, 0x4c, 0x54, 1, 1, 0, 0,
    ]);
  });

  it("emits stable kind-specific headers for every large publication", () => {
    const bytes = new Uint8Array(1);
    bytes[0] = 1;
    const signature = new Uint8Array(64).fill(2);
    const wrapper = new Uint8Array([5, 6]);
    const ownerEpochKey = {
      wrapperId: new Uint8Array(16).fill(3),
      ciphertext: new Uint8Array(48).fill(4),
    };
    const directory = encodeShareDirectoryPublication({
      directoryCbor: bytes,
      directorySignature: signature,
      wrappers: [wrapper],
    });
    const created = encodeCreateSharePublication({
      shareId: "shr_a",
      rootNodeId: "fil_b",
      recipientId: "usr_c",
      recipientKeyVersion: 7,
      wrappers: [wrapper],
      envelopes: [{ canonicalCbor: bytes, signature }],
      ownerEpochKey,
    });
    const epoch = encodePublishEpochPublication({
      fenceSnapshotHash: new Uint8Array(32).fill(8),
      wrappers: [wrapper],
      envelopes: [{ canonicalCbor: bytes, signature }],
      ownerEpochKey,
    });

    const sharedTail =
      "0000000100000002050600000001000000010100000040" +
      "02".repeat(64) +
      "00000010" +
      "03".repeat(16) +
      "00000030" +
      "04".repeat(48);
    const directoryHex =
      "41564c5401020000000000010100000040" +
      "02".repeat(64) +
      "00000001000000020506";
    const createdHex =
      "41564c5401030000000000057368725f610000000566696c5f62" +
      "000000057573725f630000000000000007" +
      sharedTail;
    const epochHex = `41564c540104000000000020${"08".repeat(32)}${sharedTail}`;

    expect([directory[5], created[5], epoch[5]]).toEqual([2, 3, 4]);
    expect(Buffer.from(directory).toString("hex")).toBe(directoryHex);
    expect(Buffer.from(created).toString("hex")).toBe(createdHex);
    expect(Buffer.from(epoch).toString("hex")).toBe(epochHex);
  });

  it("encodes parent-ordered records in one bounded binary publication", () => {
    const records = [1, 2].map((marker) => ({
      bootstrapCbor: Uint8Array.of(marker, marker + 1),
      bootstrapSignature: new Uint8Array(64).fill(marker + 2),
      encryptedManifest: new Uint8Array(16).fill(marker + 3),
      wrappers: [Uint8Array.of(marker + 4, marker + 5)],
    }));

    const encoded = encodeFolderBatchPublication(records);
    const view = new DataView(encoded.buffer);

    expect(Array.from(encoded.slice(0, 8))).toEqual([
      0x41, 0x56, 0x4c, 0x54, 1, 5, 0, 0,
    ]);
    expect(view.getUint32(8, false)).toBe(2);
    expect(encoded.length).toBe(220);
  });

  it("rejects empty and unbounded folder batches before allocating", () => {
    expect(() => encodeFolderBatchPublication([])).toThrow(/1 to 100/);
    const record = {
      bootstrapCbor: Uint8Array.of(1),
      bootstrapSignature: new Uint8Array(64),
      encryptedManifest: new Uint8Array(16),
      wrappers: [Uint8Array.of(2)],
    };
    expect(() =>
      encodeFolderBatchPublication(Array.from({ length: 101 }, () => record)),
    ).toThrow(/1 to 100/);
  });
});

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
