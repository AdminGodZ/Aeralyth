export const VAULT_PUBLICATION_CONTENT_TYPE =
  "application/vnd.aeralyth.vault-publication";

const MAGIC = new Uint8Array([0x41, 0x56, 0x4c, 0x54]);
const VERSION = 1;
const NODE_PUBLICATION = 1;
const SHARE_DIRECTORY = 2;
const CREATE_SHARE = 3;
const PUBLISH_EPOCH = 4;
const FOLDER_BATCH = 5;
const NULL_LENGTH = 0xffff_ffff;
const HEADER_BYTES = 8;
const encoder = new TextEncoder();

type CompletedPart = {
  partNumber: number;
  etag: string;
  checksumSha256: string;
};

type NodeRecord = {
  bootstrapCbor: Uint8Array;
  bootstrapSignature: Uint8Array;
  encryptedManifest: Uint8Array;
  wrappers: Uint8Array[];
};

type SignedEnvelope = {
  canonicalCbor: Uint8Array;
  signature: Uint8Array;
};

type OwnerEpochKey = {
  wrapperId: Uint8Array;
  ciphertext: Uint8Array;
};

export function encodeNodePublication(
  parts: CompletedPart[],
  record: NodeRecord,
): Uint8Array {
  const encodedParts = parts.map((part) => ({
    partNumber: part.partNumber,
    etag: encodeText(part.etag),
    checksumSha256: encodeText(part.checksumSha256),
  }));
  const size =
    HEADER_BYTES +
    4 +
    encodedParts.reduce(
      (total, part) =>
        total + 4 + sizedBytes(part.etag) + sizedBytes(part.checksumSha256),
      0,
    ) +
    sizedBytes(record.bootstrapCbor) +
    sizedBytes(record.bootstrapSignature) +
    sizedBytes(record.encryptedManifest) +
    sizedByteArray(record.wrappers);
  const writer = new Writer(size, NODE_PUBLICATION);
  writer.count(encodedParts.length);
  for (const part of encodedParts) {
    writer.u32(part.partNumber);
    writer.bytes(part.etag);
    writer.bytes(part.checksumSha256);
  }
  writer.bytes(record.bootstrapCbor);
  writer.bytes(record.bootstrapSignature);
  writer.bytes(record.encryptedManifest);
  writer.byteArray(record.wrappers);
  return writer.finish();
}

export function encodeFolderBatchPublication(
  records: NodeRecord[],
): Uint8Array {
  if (records.length < 1 || records.length > 100) {
    throw new Error("Folder publication batch must contain 1 to 100 records.");
  }
  const writer = new Writer(
    HEADER_BYTES +
      4 +
      records.reduce((total, record) => total + sizedNodeRecord(record), 0),
    FOLDER_BATCH,
  );
  writer.count(records.length);
  for (const record of records) writer.nodeRecord(record);
  return writer.finish();
}

export function encodeShareDirectoryPublication(
  publication: {
    directoryCbor: Uint8Array;
    directorySignature: Uint8Array;
    wrappers: Uint8Array[];
  } | null,
): Uint8Array {
  const directoryCbor = publication?.directoryCbor ?? null;
  const directorySignature = publication?.directorySignature ?? null;
  const wrappers = publication?.wrappers ?? [];
  const writer = new Writer(
    HEADER_BYTES +
      sizedOptionalBytes(directoryCbor) +
      sizedOptionalBytes(directorySignature) +
      sizedByteArray(wrappers),
    SHARE_DIRECTORY,
  );
  writer.optionalBytes(directoryCbor);
  writer.optionalBytes(directorySignature);
  writer.byteArray(wrappers);
  return writer.finish();
}

export function encodeCreateSharePublication(publication: {
  shareId: string;
  rootNodeId: string;
  recipientId: string;
  recipientKeyVersion: number;
  wrappers: Uint8Array[];
  envelopes: SignedEnvelope[];
  ownerEpochKey: OwnerEpochKey;
}): Uint8Array {
  const shareId = encodeText(publication.shareId);
  const rootNodeId = encodeText(publication.rootNodeId);
  const recipientId = encodeText(publication.recipientId);
  const writer = new Writer(
    HEADER_BYTES +
      sizedBytes(shareId) +
      sizedBytes(rootNodeId) +
      sizedBytes(recipientId) +
      8 +
      sizedByteArray(publication.wrappers) +
      sizedEnvelopes(publication.envelopes) +
      sizedBytes(publication.ownerEpochKey.wrapperId) +
      sizedBytes(publication.ownerEpochKey.ciphertext),
    CREATE_SHARE,
  );
  writer.bytes(shareId);
  writer.bytes(rootNodeId);
  writer.bytes(recipientId);
  writer.u64(publication.recipientKeyVersion);
  writer.byteArray(publication.wrappers);
  writer.envelopes(publication.envelopes);
  writer.bytes(publication.ownerEpochKey.wrapperId);
  writer.bytes(publication.ownerEpochKey.ciphertext);
  return writer.finish();
}

export function encodePublishEpochPublication(publication: {
  fenceSnapshotHash: Uint8Array;
  wrappers: Uint8Array[];
  envelopes: SignedEnvelope[];
  ownerEpochKey: OwnerEpochKey;
}): Uint8Array {
  const writer = new Writer(
    HEADER_BYTES +
      sizedBytes(publication.fenceSnapshotHash) +
      sizedByteArray(publication.wrappers) +
      sizedEnvelopes(publication.envelopes) +
      sizedBytes(publication.ownerEpochKey.wrapperId) +
      sizedBytes(publication.ownerEpochKey.ciphertext),
    PUBLISH_EPOCH,
  );
  writer.bytes(publication.fenceSnapshotHash);
  writer.byteArray(publication.wrappers);
  writer.envelopes(publication.envelopes);
  writer.bytes(publication.ownerEpochKey.wrapperId);
  writer.bytes(publication.ownerEpochKey.ciphertext);
  return writer.finish();
}

class Writer {
  private readonly output: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number, kind: number) {
    this.output = new Uint8Array(size);
    this.view = new DataView(this.output.buffer);
    this.output.set(MAGIC, 0);
    this.output[4] = VERSION;
    this.output[5] = kind;
    this.offset = HEADER_BYTES;
  }

  finish(): Uint8Array {
    if (this.offset !== this.output.length) {
      throw new Error("Vault publication encoder size mismatch.");
    }
    return this.output;
  }

  count(value: number): void {
    this.u32(value);
  }

  u32(value: number): void {
    assertUnsigned(value, 0xffff_ffff);
    this.view.setUint32(this.offset, value, false);
    this.offset += 4;
  }

  u64(value: number): void {
    assertUnsigned(value, Number.MAX_SAFE_INTEGER);
    this.view.setBigUint64(this.offset, BigInt(value), false);
    this.offset += 8;
  }

  bytes(value: Uint8Array): void {
    this.u32(value.length);
    this.output.set(value, this.offset);
    this.offset += value.length;
  }

  optionalBytes(value: Uint8Array | null): void {
    if (value === null) {
      this.u32(NULL_LENGTH);
    } else {
      this.bytes(value);
    }
  }

  byteArray(values: Uint8Array[]): void {
    this.count(values.length);
    for (const value of values) this.bytes(value);
  }

  envelopes(values: SignedEnvelope[]): void {
    this.count(values.length);
    for (const value of values) {
      this.bytes(value.canonicalCbor);
      this.bytes(value.signature);
    }
  }

  nodeRecord(record: NodeRecord): void {
    this.bytes(record.bootstrapCbor);
    this.bytes(record.bootstrapSignature);
    this.bytes(record.encryptedManifest);
    this.byteArray(record.wrappers);
  }
}

function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}

function sizedBytes(value: Uint8Array): number {
  assertUnsigned(value.length, 0xffff_fffe);
  return 4 + value.length;
}

function sizedOptionalBytes(value: Uint8Array | null): number {
  return value === null ? 4 : sizedBytes(value);
}

function sizedByteArray(values: Uint8Array[]): number {
  return 4 + values.reduce((total, value) => total + sizedBytes(value), 0);
}

function sizedEnvelopes(values: SignedEnvelope[]): number {
  return (
    4 +
    values.reduce(
      (total, value) =>
        total + sizedBytes(value.canonicalCbor) + sizedBytes(value.signature),
      0,
    )
  );
}

function sizedNodeRecord(record: NodeRecord): number {
  return (
    sizedBytes(record.bootstrapCbor) +
    sizedBytes(record.bootstrapSignature) +
    sizedBytes(record.encryptedManifest) +
    sizedByteArray(record.wrappers)
  );
}

function assertUnsigned(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("Vault publication integer is out of range.");
  }
}
