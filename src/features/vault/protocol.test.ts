import { describe, expect, it } from "vitest";

import {
  decodeBootstrap,
  decodeShareEnvelope,
  decodeWrapper,
  encodeBootstrap,
  encodeShareEnvelope,
  encodeWrapper,
} from "@/features/vault/cbor";
import {
  chunkNonce,
  ciphertextLeafHash,
  encodeChunkAad,
  encodeVaultRewrapProof,
  encryptedLength,
  equalBytes,
  merkleRootFromLeaves,
  padmeLength,
  toArrayBuffer,
  toBase64Url,
  VAULT_AAD_SCHEMA_ID,
  VAULT_FORMAT_VERSION,
  VAULT_SUITE_ID,
} from "@/features/vault/protocol";

describe("vault protocol", () => {
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
    };
    const decodedEnvelope = decodeShareEnvelope(encodeShareEnvelope(envelope));
    expect(decodedEnvelope.senderId).toBe("usr_sender");
    expect(decodedEnvelope.recipientId).toBe("usr_recipient");
    expect(decodedEnvelope.previousRecordHash).toEqual(
      envelope.previousRecordHash,
    );
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
