import { describe, expect, it } from "vitest";

import {
  decodeBootstrap,
  decodeShareDirectory,
  decodeShareEnvelope,
  decodeWrapper,
  encodeBootstrap,
  encodeShareDirectory,
  encodeShareEnvelope,
  encodeWrapper,
} from "@/features/vault/cbor";
import {
  asBufferSource,
  chunkNonce,
  ciphertextLeafHash,
  encodeChunkAad,
  encodeVaultRewrapProof,
  encryptedLength,
  equalBytes,
  fillRandomBytes,
  MAX_SHARE_WRAPPERS,
  merkleRootFromLeaves,
  padmeLength,
  sha256,
  sha256Parts,
  shareAuthorizationVersion,
  toArrayBuffer,
  toBase64Url,
  VAULT_AAD_SCHEMA_ID,
  VAULT_FORMAT_VERSION,
  VAULT_SHARE_DIRECTORY_VERSION,
  VAULT_SHARE_ENVELOPE_VERSION,
  VAULT_SUITE_ID,
  verifyWrapperSetProof,
  wrapperSetRoot,
} from "@/features/vault/protocol";

describe("vault protocol", () => {
  it("preserves one-shot SHA-256 vectors across incremental parts", async () => {
    const parts = [Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3, 4)];

    expect(await sha256Parts(...parts)).toEqual(
      await sha256(Uint8Array.of(1, 2, 3, 4)),
    );
  });

  it("matches the Rust share-authorization version vector", async () => {
    const version = await shareAuthorizationVersion({
      shareId: "shr_test",
      epoch: 2,
      recipientId: "usr_recipient",
      recipientKeyVersion: 4,
      shareRecordVersion: 7,
      envelopeHash: new Uint8Array(32).fill(9),
    });

    expect(Buffer.from(version).toString("hex")).toBe(
      "99ee526ddf51decc35bcba6dddd7ead44d5fa3b6c34f8acd539e1c4cc3d80581",
    );
  });

  it("fills random padding beyond Web Crypto's per-call quota", () => {
    const output = new Uint8Array(65_536 * 2 + 7);

    expect(fillRandomBytes(output)).toBe(output);
    expect(output.some((value) => value !== 0)).toBe(true);
  });

  it("reuses owned ArrayBuffers and only copies partial ranges", () => {
    const whole = Uint8Array.from([1, 2, 3, 4]);
    const parent = Uint8Array.from([9, 8, 7, 6]);
    const partial = parent.subarray(1, 3);

    expect(toArrayBuffer(whole)).toBe(whole.buffer);
    const partialBuffer = toArrayBuffer(partial);
    expect(partialBuffer).not.toBe(parent.buffer);
    expect(new Uint8Array(partialBuffer)).toEqual(Uint8Array.from([8, 7]));

    const source = asBufferSource(partial);
    expect(source.buffer).toBe(parent.buffer);
    expect(source.byteOffset).toBe(partial.byteOffset);
    expect(source.byteLength).toBe(partial.byteLength);
  });

  it("encodes the canonical bootstrap vector accepted by the Rust decoder", () => {
    const encoded = encodeBootstrap({
      formatVersion: VAULT_FORMAT_VERSION,
      suiteId: VAULT_SUITE_ID,
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
      nodeId: "fil_test123",
      generationNumber: 1,
      generationId: new Uint8Array(16).fill(1),
      manifestIv: new Uint8Array(12),
      wrapperIds: [new Uint8Array(16).fill(2)],
      ciphertextLength: 4112,
      signerKeyVersion: 1,
      recordVersion: 1,
      previousRecordHash: null,
      manifestHash: new Uint8Array(32).fill(3),
      wrapperHashes: [new Uint8Array(32).fill(4)],
      ciphertextMerkleRoot: new Uint8Array(32).fill(5),
    });

    expect(Buffer.from(encoded).toString("hex")).toBe(
      "af010102010301046b66696c5f746573743132330501065001010101010101010101010101010101074c00000000000000000000000008815002020202020202020202020202020202091910100a010b010cf60d582003030303030303030303030303030303030303030303030303030303030303030e81582004040404040404040404040404040404040404040404040404040404040404040f58200505050505050505050505050505050505050505050505050505050505050505",
    );
    expect(decodeBootstrap(encoded).nodeId).toBe("fil_test123");
  });

  it("rejects non-minimal CBOR integers", () => {
    const malformed = Uint8Array.of(0xaf, 0x18, 0x01);
    expect(() => decodeBootstrap(malformed)).toThrow(/Non-minimal/u);
  });

  it("encodes a constant-size record-bound share-wrapper directory", () => {
    const encoded = encodeShareDirectory({
      formatVersion: VAULT_SHARE_DIRECTORY_VERSION,
      suiteId: VAULT_SUITE_ID,
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
      nodeId: "fil_test123",
      recordVersion: 2,
      recordHash: new Uint8Array(32).fill(3),
      generationNumber: 4,
      generationId: new Uint8Array(16).fill(5),
      signerKeyVersion: 6,
      wrapperSetRoot: new Uint8Array(32).fill(7),
      wrapperCount: 100,
    });

    expect(Buffer.from(encoded).toString("hex")).toBe(
      "ab010102010301046b66696c5f7465737431323305020658200303030303030303030303030303030303030303030303030303030303030303070408500505050505050505050505050505050509060a582007070707070707070707070707070707070707070707070707070707070707070b1864",
    );
    expect(decodeShareDirectory(encoded).wrapperCount).toBe(100);
    expect(encoded.length).toBeLessThan(256);
  });

  it.each([
    ["indefinite maps", Uint8Array.of(0xbf, 0xff)],
    ["floating point values", Uint8Array.of(0xa1, 0x01, 0xf9, 0x00, 0x00)],
    ["out-of-order map keys", Uint8Array.of(0xa2, 0x02, 0x01, 0x01, 0x01)],
  ])("rejects %s", (_label, malformed) => {
    expect(() => decodeBootstrap(malformed)).toThrow();
  });

  it("rejects trailing CBOR bytes", () => {
    const valid = encodeBootstrap(bootstrapFixture());
    const malformed = new Uint8Array(valid.length + 1);
    malformed.set(valid);
    expect(() => decodeBootstrap(malformed)).toThrow(/trailing/u);
  });

  it("round-trips fixed wrapper and authenticated envelope fields", () => {
    const wrapper = {
      formatVersion: VAULT_FORMAT_VERSION,
      wrapperId: new Uint8Array(16).fill(7),
      kind: 3 as const,
      nodeId: "fil_test123",
      parentNodeId: null,
      generationId: new Uint8Array(16).fill(8),
      shareId: "shr_test123",
      epoch: 2,
      recordVersion: 4,
      ciphertext: new Uint8Array(48).fill(9),
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
    };
    const decodedWrapper = decodeWrapper(encodeWrapper(wrapper));
    expect(decodedWrapper.kind).toBe(3);
    expect(decodedWrapper.shareId).toBe("shr_test123");
    expect(decodedWrapper.ciphertext).toEqual(wrapper.ciphertext);

    const envelope = {
      formatVersion: VAULT_FORMAT_VERSION,
      suiteId: VAULT_SUITE_ID,
      envelopeId: new Uint8Array(16).fill(10),
      shareId: "shr_test123",
      epoch: 2,
      senderId: "usr_sender",
      senderKeyVersion: 3,
      recipientId: "usr_recipient",
      recipientKeyVersion: 4,
      nodeId: "fil_test123",
      permissions: 1 as const,
      generationScope: null,
      recordVersion: 5,
      previousRecordHash: new Uint8Array(32).fill(11),
      encapsulatedKey: new Uint8Array(32).fill(12),
      ciphertext: new Uint8Array(48).fill(13),
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
      wrapperHashes: [new Uint8Array(32).fill(14)],
      wrapperSetRoot: null,
      wrapperCount: 1,
    };
    const decodedEnvelope = decodeShareEnvelope(encodeShareEnvelope(envelope));
    expect(decodedEnvelope.senderId).toBe("usr_sender");
    expect(decodedEnvelope.recipientId).toBe("usr_recipient");
    expect(decodedEnvelope.previousRecordHash).toEqual(
      envelope.previousRecordHash,
    );
  });

  it("keeps protocol-v2 recipient envelopes constant-sized", async () => {
    const root = await wrapperSetRoot([new Uint8Array(32).fill(14)]);
    const baseEnvelope = {
      formatVersion: VAULT_SHARE_ENVELOPE_VERSION,
      suiteId: VAULT_SUITE_ID,
      envelopeId: new Uint8Array(16).fill(10),
      shareId: "shr_test123",
      epoch: 2,
      senderId: "usr_sender",
      senderKeyVersion: 3,
      recipientId: "usr_recipient",
      recipientKeyVersion: 4,
      nodeId: "fil_test123",
      permissions: 1 as const,
      generationScope: null,
      recordVersion: 5,
      previousRecordHash: new Uint8Array(32).fill(11),
      encapsulatedKey: new Uint8Array(32).fill(12),
      ciphertext: new Uint8Array(48).fill(13),
      aadSchemaId: VAULT_AAD_SCHEMA_ID,
      wrapperHashes: [],
      wrapperSetRoot: root,
      wrapperCount: 1,
    };
    const oneWrapper = encodeShareEnvelope(baseEnvelope);
    const thousands = encodeShareEnvelope({
      ...baseEnvelope,
      wrapperCount: 4096,
    });
    const decoded = decodeShareEnvelope(oneWrapper);

    expect(decoded.wrapperSetRoot).toEqual(root);
    expect(decoded.wrapperCount).toBe(1);
    expect(oneWrapper.length).toBeLessThan(300);
    expect(Math.abs(thousands.length - oneWrapper.length)).toBeLessThanOrEqual(
      2,
    );
  });

  it("matches the cross-runtime wrapper-set commitment vector", async () => {
    const root = await wrapperSetRoot([
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
    ]);

    expect(Buffer.from(root).toString("hex")).toBe(
      "e3204f260c1b5a7ac452b00bf91a562062bdbff758ed8e6386e732f63bee709b",
    );
    expect(
      await verifyWrapperSetProof({
        wrapperHash: new Uint8Array(32).fill(1),
        leafIndex: 0,
        proof: Uint8Array.from(
          Buffer.from(
            "c635a2f3548516774fe0d5d4e652f36ab67baebf95b29110032e50d0276293368adc76e8e70bb7eb0278ae2f5dab61b0509ae2fa5f62b179b117381304185af3",
            "hex",
          ),
        ),
        wrapperCount: 3,
        expectedRoot: root,
      }),
    ).toBe(true);
  });

  it("builds the maximum 50,000-file share commitment", async () => {
    const hashes = Array.from({ length: MAX_SHARE_WRAPPERS }, (_, index) => {
      const hash = new Uint8Array(32);
      new DataView(hash.buffer).setUint32(28, index);
      return hash;
    });

    await expect(wrapperSetRoot(hashes)).resolves.toHaveLength(32);
  });

  it("uses a deterministic 96-bit big-endian chunk counter", () => {
    expect(Array.from(chunkNonce(0))).toEqual(new Array(12).fill(0));
    expect(Array.from(chunkNonce(0x1_0000_0001))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
  });

  it("pads small payloads and accounts for one GCM tag per chunk", () => {
    expect(padmeLength(0)).toBe(4096);
    expect(padmeLength(4097)).toBeGreaterThanOrEqual(4097);
    expect(encryptedLength(4096)).toEqual({
      chunkCount: 1,
      ciphertextBytes: 4112,
    });
  });

  it("matches the protocol Merkle construction", async () => {
    const first = Uint8Array.of(1, 2, 3);
    const second = Uint8Array.of(4, 5);
    const root = await merkleRootFromLeaves([
      await ciphertextLeafHash(0, first),
      await ciphertextLeafHash(1, second),
    ]);
    expect(Buffer.from(root).toString("hex")).toBe(
      "067eda05bac90de5289cf88f7cbb6fcd9af6f7173a79009712b9a1d25881d2df",
    );
    const tamperedRoot = await merkleRootFromLeaves([
      await ciphertextLeafHash(0, Uint8Array.of(1, 2, 4)),
      await ciphertextLeafHash(1, second),
    ]);
    expect(equalBytes(root, tamperedRoot)).toBe(false);
  });

  it("authenticates chunk ciphertext and AAD", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(21),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const generationId = new Uint8Array(16).fill(22);
    const aad = encodeChunkAad({
      nodeId: "fil_test123",
      generationNumber: 1,
      generationId,
      chunkIndex: 0,
      plaintextLength: 3,
    });
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(chunkNonce(0)),
          additionalData: toArrayBuffer(aad),
        },
        key,
        Uint8Array.of(1, 2, 3),
      ),
    );
    ciphertext[0] ^= 1;
    await expect(
      crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(chunkNonce(0)),
          additionalData: toArrayBuffer(aad),
        },
        key,
        ciphertext,
      ),
    ).rejects.toThrow();
  });

  it("binds every recovery rewrap field into a deterministic proof", () => {
    const payload = {
      expectedVaultVersion: 7,
      recovery: true,
      kdf: {
        algorithm: "argon2id13",
        salt: toBase64Url(new Uint8Array(16).fill(1)),
        operations: 3,
        memoryBytes: 268_435_456,
        outputBytes: 32,
      },
      passwordWrapper: {
        id: toBase64Url(new Uint8Array(16).fill(2)),
        ciphertext: toBase64Url(new Uint8Array(48).fill(3)),
      },
      recoveryWrapper: {
        salt: toBase64Url(new Uint8Array(16).fill(4)),
        id: toBase64Url(new Uint8Array(16).fill(5)),
        ciphertext: toBase64Url(new Uint8Array(48).fill(6)),
      },
      accountStateRecordId: toBase64Url(new Uint8Array(16).fill(7)),
      encryptedAccountState: toBase64Url(new Uint8Array(64).fill(8)),
    };
    const first = encodeVaultRewrapProof(payload);
    const second = encodeVaultRewrapProof(payload);
    expect(first).toEqual(second);

    const changed = encodeVaultRewrapProof({
      ...payload,
      expectedVaultVersion: 8,
    });
    expect(equalBytes(first, changed)).toBe(false);
  });
});

function bootstrapFixture() {
  return {
    formatVersion: VAULT_FORMAT_VERSION,
    suiteId: VAULT_SUITE_ID,
    aadSchemaId: VAULT_AAD_SCHEMA_ID,
    nodeId: "fil_test123",
    generationNumber: 1,
    generationId: new Uint8Array(16).fill(1),
    manifestIv: new Uint8Array(12),
    wrapperIds: [new Uint8Array(16).fill(2)],
    ciphertextLength: 4112,
    signerKeyVersion: 1,
    recordVersion: 1,
    previousRecordHash: null,
    manifestHash: new Uint8Array(32).fill(3),
    wrapperHashes: [new Uint8Array(32).fill(4)],
    ciphertextMerkleRoot: new Uint8Array(32).fill(5),
  };
}
