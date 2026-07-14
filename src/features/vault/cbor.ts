import type {
  VaultBootstrapRecord,
  VaultManifest,
  VaultShareEnvelopeRecord,
  VaultWrapperRecord,
} from "@/features/vault/protocol";

type CborScalar = number | string | Uint8Array | null;
type CborValue = CborScalar | CborValue[] | Map<number, CborValue>;

export function encodeBootstrap(record: VaultBootstrapRecord): Uint8Array {
  return encodeMap([
    [1, record.formatVersion],
    [2, record.suiteId],
    [3, record.aadSchemaId],
    [4, record.nodeId],
    [5, record.generationNumber],
    [6, record.generationId],
    [7, record.manifestIv],
    [8, record.wrapperIds],
    [9, record.ciphertextLength],
    [10, record.signerKeyVersion],
    [11, record.recordVersion],
    [12, record.previousRecordHash],
    [13, record.manifestHash],
    [14, record.wrapperHashes],
    [15, record.ciphertextMerkleRoot],
  ]);
}

export function decodeBootstrap(value: Uint8Array): VaultBootstrapRecord {
  const map = decodeExactMap(value, 15);
  return {
    formatVersion: requiredNumber(map, 1),
    suiteId: requiredNumber(map, 2),
    aadSchemaId: requiredNumber(map, 3),
    nodeId: requiredString(map, 4),
    generationNumber: requiredNumber(map, 5),
    generationId: fixedBytes(map, 6, 16),
    manifestIv: fixedBytes(map, 7, 12),
    wrapperIds: fixedBytesArray(map, 8, 16),
    ciphertextLength: requiredNumber(map, 9),
    signerKeyVersion: requiredNumber(map, 10),
    recordVersion: requiredNumber(map, 11),
    previousRecordHash: nullableFixedBytes(map, 12, 32),
    manifestHash: fixedBytes(map, 13, 32),
    wrapperHashes: fixedBytesArray(map, 14, 32),
    ciphertextMerkleRoot: fixedBytes(map, 15, 32),
  };
}

export function encodeWrapper(record: VaultWrapperRecord): Uint8Array {
  return encodeMap([
    [1, record.formatVersion],
    [2, record.wrapperId],
    [3, record.kind],
    [4, record.nodeId],
    [5, record.parentNodeId],
    [6, record.generationId],
    [7, record.shareId],
    [8, record.epoch],
    [9, record.recordVersion],
    [10, record.ciphertext],
    [11, record.aadSchemaId],
  ]);
}

export function decodeWrapper(value: Uint8Array): VaultWrapperRecord {
  const map = decodeExactMap(value, 11);
  const kind = requiredNumber(map, 3);
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) {
    throw new Error("Unsupported vault wrapper kind.");
  }
  return {
    formatVersion: requiredNumber(map, 1),
    wrapperId: fixedBytes(map, 2, 16),
    kind,
    nodeId: requiredString(map, 4),
    parentNodeId: nullableString(map, 5),
    generationId: nullableFixedBytes(map, 6, 16),
    shareId: nullableString(map, 7),
    epoch: nullableNumber(map, 8),
    recordVersion: requiredNumber(map, 9),
    ciphertext: requiredBytes(map, 10),
    aadSchemaId: requiredNumber(map, 11),
  };
}

export function encodeManifest(manifest: VaultManifest): Uint8Array {
  return encodeMap([
    [1, manifest.name],
    [2, manifest.mimeType],
    [3, manifest.entryType === "file" ? 1 : 2],
    [4, manifest.plaintextBytes],
    [5, manifest.paddedBytes],
    [6, manifest.lastModified],
    [7, manifest.parentId],
    [8, manifest.chunkCount],
    [9, manifest.generationId],
    [10, manifest.createdAt],
  ]);
}

export function decodeManifest(value: Uint8Array): VaultManifest {
  const map = decodeExactMap(value, 10);
  const entryType = requiredNumber(map, 3);
  if (entryType !== 1 && entryType !== 2) {
    throw new Error("Invalid vault manifest entry type.");
  }
  return {
    name: requiredString(map, 1),
    mimeType: nullableString(map, 2),
    entryType: entryType === 1 ? "file" : "folder",
    plaintextBytes: requiredNumber(map, 4),
    paddedBytes: requiredNumber(map, 5),
    lastModified: requiredNumber(map, 6),
    parentId: nullableString(map, 7),
    chunkCount: requiredNumber(map, 8),
    generationId: fixedBytes(map, 9, 16),
    createdAt: requiredNumber(map, 10),
  };
}

export function encodeShareEnvelope(
  record: VaultShareEnvelopeRecord,
): Uint8Array {
  return encodeMap([
    [1, record.formatVersion],
    [2, record.suiteId],
    [3, record.envelopeId],
    [4, record.shareId],
    [5, record.epoch],
    [6, record.senderId],
    [7, record.senderKeyVersion],
    [8, record.recipientId],
    [9, record.recipientKeyVersion],
    [10, record.nodeId],
    [11, record.permissions],
    [12, record.generationScope],
    [13, record.recordVersion],
    [14, record.previousRecordHash],
    [15, record.encapsulatedKey],
    [16, record.ciphertext],
    [17, record.aadSchemaId],
    [18, record.wrapperHashes],
  ]);
}

export function decodeShareEnvelope(
  value: Uint8Array,
): VaultShareEnvelopeRecord {
  const map = decodeExactMap(value, 18);
  const permissions = requiredNumber(map, 11);
  if (permissions !== 1) throw new Error("Unsupported share permissions.");
  return {
    formatVersion: requiredNumber(map, 1),
    suiteId: requiredNumber(map, 2),
    envelopeId: fixedBytes(map, 3, 16),
    shareId: requiredString(map, 4),
    epoch: requiredNumber(map, 5),
    senderId: requiredString(map, 6),
    senderKeyVersion: requiredNumber(map, 7),
    recipientId: requiredString(map, 8),
    recipientKeyVersion: requiredNumber(map, 9),
    nodeId: requiredString(map, 10),
    permissions,
    generationScope: nullableNumber(map, 12),
    recordVersion: requiredNumber(map, 13),
    previousRecordHash: nullableFixedBytes(map, 14, 32),
    encapsulatedKey: fixedBytes(map, 15, 32),
    ciphertext: requiredBytes(map, 16),
    aadSchemaId: requiredNumber(map, 17),
    wrapperHashes: fixedBytesArray(map, 18, 32),
  };
}

export function encodeMap(entries: Array<[number, CborValue]>): Uint8Array {
  const output: number[] = [];
  writeHead(output, 5, entries.length);
  let previous = 0;
  for (const [key, value] of entries) {
    if (!Number.isSafeInteger(key) || key <= previous) {
      throw new Error("CBOR map keys must be positive and strictly ordered.");
    }
    writeUnsigned(output, key);
    writeValue(output, value);
    previous = key;
  }
  return Uint8Array.from(output);
}

class Reader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  finish(): void {
    if (this.offset !== this.input.length) {
      throw new Error("CBOR value has trailing bytes.");
    }
  }

  value(): CborValue {
    const initial = this.byte();
    if (initial === 0xf6) {
      return null;
    }
    const major = initial >>> 5;
    const additional = initial & 31;
    if (major === 0) {
      return this.length(additional);
    }
    if (major === 2 || major === 3) {
      const length = this.length(additional);
      const bytes = this.take(length);
      return major === 2
        ? bytes
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (major === 4) {
      const length = this.length(additional);
      return Array.from({ length }, () => this.value());
    }
    if (major === 5) {
      const length = this.length(additional);
      const map = new Map<number, CborValue>();
      let previous = 0;
      for (let index = 0; index < length; index += 1) {
        const key = this.value();
        if (typeof key !== "number" || key <= previous || map.has(key)) {
          throw new Error("CBOR map keys are not canonically ordered.");
        }
        map.set(key, this.value());
        previous = key;
      }
      return map;
    }
    throw new Error("Unsupported CBOR type.");
  }

  private byte(): number {
    const value = this.input[this.offset];
    if (value === undefined) {
      throw new Error("Unexpected end of CBOR value.");
    }
    this.offset += 1;
    return value;
  }

  private take(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.input.length
    ) {
      throw new Error("Invalid CBOR length.");
    }
    const value = this.input.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private length(additional: number): number {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      const value = this.byte();
      if (value < 24) throw new Error("Non-minimal CBOR integer.");
      return value;
    }
    if (additional === 25) {
      const bytes = this.take(2);
      const value = new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(
        0,
        false,
      );
      if (value <= 0xff) throw new Error("Non-minimal CBOR integer.");
      return value;
    }
    if (additional === 26) {
      const bytes = this.take(4);
      const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(
        0,
        false,
      );
      if (value <= 0xffff) throw new Error("Non-minimal CBOR integer.");
      return value;
    }
    if (additional === 27) {
      const bytes = this.take(8);
      const value = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        8,
      ).getBigUint64(0, false);
      if (value <= 0xffff_ffffn || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Unsupported CBOR integer.");
      }
      return Number(value);
    }
    throw new Error("Indefinite-length CBOR is forbidden.");
  }
}

function decodeExactMap(
  value: Uint8Array,
  fieldCount: number,
): Map<number, CborValue> {
  const reader = new Reader(value);
  const decoded = reader.value();
  reader.finish();
  if (!(decoded instanceof Map) || decoded.size !== fieldCount) {
    throw new Error("CBOR record has an invalid field count.");
  }
  for (let key = 1; key <= fieldCount; key += 1) {
    if (!decoded.has(key)) {
      throw new Error("CBOR record is missing a required field.");
    }
  }
  return decoded;
}

function writeValue(output: number[], value: CborValue): void {
  if (value === null) {
    output.push(0xf6);
  } else if (typeof value === "number") {
    writeUnsigned(output, value);
  } else if (typeof value === "string") {
    const encoded = new TextEncoder().encode(value);
    writeHead(output, 3, encoded.length);
    output.push(...encoded);
  } else if (value instanceof Uint8Array) {
    writeHead(output, 2, value.length);
    output.push(...value);
  } else if (Array.isArray(value)) {
    writeHead(output, 4, value.length);
    for (const item of value) writeValue(output, item);
  } else if (value instanceof Map) {
    writeHead(output, 5, value.size);
    let previous = 0;
    for (const [key, item] of value) {
      if (key <= previous) throw new Error("CBOR map keys are not ordered.");
      writeUnsigned(output, key);
      writeValue(output, item);
      previous = key;
    }
  } else {
    const neverValue: never = value;
    throw new Error(`Unsupported CBOR value: ${String(neverValue)}`);
  }
}

function writeUnsigned(output: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("CBOR only supports non-negative safe integers.");
  }
  writeHead(output, 0, value);
}

function writeHead(output: number[], major: number, value: number): void {
  if (value < 24) {
    output.push((major << 5) | value);
  } else if (value <= 0xff) {
    output.push((major << 5) | 24, value);
  } else if (value <= 0xffff) {
    output.push((major << 5) | 25, value >>> 8, value & 0xff);
  } else if (value <= 0xffff_ffff) {
    output.push((major << 5) | 26);
    for (let shift = 24; shift >= 0; shift -= 8)
      output.push((value >>> shift) & 0xff);
  } else {
    output.push((major << 5) | 27);
    let remaining = BigInt(value);
    const bytes = new Array<number>(8);
    for (let index = 7; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    output.push(...bytes);
  }
}

function field(map: Map<number, CborValue>, key: number): CborValue {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing CBOR field ${key}.`);
  return value;
}

function requiredNumber(map: Map<number, CborValue>, key: number): number {
  const value = field(map, key);
  if (typeof value !== "number")
    throw new Error(`CBOR field ${key} is not an integer.`);
  return value;
}

function nullableNumber(
  map: Map<number, CborValue>,
  key: number,
): number | null {
  const value = field(map, key);
  if (value === null) return null;
  if (typeof value !== "number")
    throw new Error(`CBOR field ${key} is not an integer.`);
  return value;
}

function requiredString(map: Map<number, CborValue>, key: number): string {
  const value = field(map, key);
  if (typeof value !== "string")
    throw new Error(`CBOR field ${key} is not text.`);
  return value;
}

function nullableString(
  map: Map<number, CborValue>,
  key: number,
): string | null {
  const value = field(map, key);
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error(`CBOR field ${key} is not text.`);
  return value;
}

function requiredBytes(map: Map<number, CborValue>, key: number): Uint8Array {
  const value = field(map, key);
  if (!(value instanceof Uint8Array))
    throw new Error(`CBOR field ${key} is not bytes.`);
  return value;
}

function fixedBytes(
  map: Map<number, CborValue>,
  key: number,
  length: number,
): Uint8Array {
  const value = requiredBytes(map, key);
  if (value.length !== length)
    throw new Error(`CBOR field ${key} has an invalid length.`);
  return value;
}

function nullableFixedBytes(
  map: Map<number, CborValue>,
  key: number,
  length: number,
): Uint8Array | null {
  const value = field(map, key);
  if (value === null) return null;
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`CBOR field ${key} has an invalid length.`);
  }
  return value;
}

function fixedBytesArray(
  map: Map<number, CborValue>,
  key: number,
  length: number,
): Uint8Array[] {
  const value = field(map, key);
  if (!Array.isArray(value))
    throw new Error(`CBOR field ${key} is not an array.`);
  return value.map((item) => {
    if (!(item instanceof Uint8Array) || item.length !== length) {
      throw new Error(`CBOR field ${key} contains an invalid byte string.`);
    }
    return item;
  });
}
