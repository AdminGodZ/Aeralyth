// Minimal ZIP container writer: local file headers, the central directory and
// the end-of-central-directory records, including ZIP64. Entry sizes and CRCs
// are known before a header is written, so no data descriptors are needed.

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

export type ZipCompressionMethod =
  | typeof ZIP_METHOD_STORE
  | typeof ZIP_METHOD_DEFLATE;

export type ZipEntryHeader = {
  /** UTF-8 entry path; directories end with "/". */
  name: Uint8Array;
  directory: boolean;
  method: ZipCompressionMethod;
  /** Deflate level, recorded in the informational general-purpose bits. */
  level: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Milliseconds since the Unix epoch. */
  lastModified: number;
};

export type ZipCentralEntry = ZipEntryHeader & {
  /** Offset of the entry's local file header from the start of the archive. */
  offset: number;
};

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_RECORD_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const UNIX_TIME_FIELD_BYTES = 9;
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;
const HOST_UNIX = 3;
const FLAG_UTF8 = 0x0800;
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const UNIX_DIRECTORY_ATTRIBUTES = ((0o040755 << 16) | 0x10) >>> 0;

const textEncoder = new TextEncoder();

export function encodeZipEntryName(path: string): Uint8Array {
  const name = textEncoder.encode(path);
  if (name.length > UINT16_MAX) {
    throw new Error("A ZIP entry path is longer than 65,535 bytes.");
  }
  return name;
}

export function localFileHeaderSize(
  nameLength: number,
  lastModified: number,
  zip64Sizes = false,
): number {
  return (
    LOCAL_HEADER_BYTES +
    nameLength +
    (zip64Sizes ? 20 : 0) +
    (unixSeconds(lastModified) === null ? 0 : UNIX_TIME_FIELD_BYTES)
  );
}

export function needsZip64Sizes(entry: {
  compressedSize: number;
  uncompressedSize: number;
}): boolean {
  return (
    entry.compressedSize >= UINT32_MAX || entry.uncompressedSize >= UINT32_MAX
  );
}

/** Writes the local file header at `offset` and returns its length. */
export function writeLocalFileHeader(
  target: Uint8Array,
  offset: number,
  entry: ZipEntryHeader,
): number {
  const zip64 = needsZip64Sizes(entry);
  const seconds = unixSeconds(entry.lastModified);
  const extraLength =
    (zip64 ? 20 : 0) + (seconds === null ? 0 : UNIX_TIME_FIELD_BYTES);
  const length = LOCAL_HEADER_BYTES + entry.name.length + extraLength;
  const view = new DataView(target.buffer, target.byteOffset + offset, length);
  const { time, date } = dosDateTime(entry.lastModified);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, zip64 ? VERSION_ZIP64 : VERSION_DEFLATE, true);
  view.setUint16(6, generalPurposeFlags(entry), true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, entry.crc32 >>> 0, true);
  view.setUint32(18, zip64 ? UINT32_MAX : entry.compressedSize, true);
  view.setUint32(22, zip64 ? UINT32_MAX : entry.uncompressedSize, true);
  view.setUint16(26, entry.name.length, true);
  view.setUint16(28, extraLength, true);
  target.set(entry.name, offset + LOCAL_HEADER_BYTES);

  let position = LOCAL_HEADER_BYTES + entry.name.length;
  if (zip64) {
    view.setUint16(position, 0x0001, true);
    view.setUint16(position + 2, 16, true);
    setUint64(view, position + 4, entry.uncompressedSize);
    setUint64(view, position + 12, entry.compressedSize);
    position += 20;
  }
  if (seconds !== null) writeUnixTimeField(view, position, seconds);
  return length;
}

export function encodeLocalFileHeader(
  entry: ZipEntryHeader,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(
    localFileHeaderSize(
      entry.name.length,
      entry.lastModified,
      needsZip64Sizes(entry),
    ),
  );
  writeLocalFileHeader(header, 0, entry);
  return header;
}

/**
 * Encodes the central directory followed by the end-of-central-directory
 * records for entries that start at the given offsets. `directoryOffset` is
 * where the returned bytes will be placed in the archive.
 */
export function encodeCentralDirectory(
  entries: readonly ZipCentralEntry[],
  directoryOffset: number,
): Uint8Array<ArrayBuffer> {
  let directoryLength = 0;
  for (const entry of entries) {
    directoryLength += CENTRAL_HEADER_BYTES + entry.name.length;
    directoryLength += centralExtraLength(entry);
  }
  const zip64 =
    entries.length >= UINT16_MAX ||
    directoryLength >= UINT32_MAX ||
    directoryOffset >= UINT32_MAX;
  const output = new Uint8Array(
    directoryLength +
      (zip64 ? ZIP64_END_RECORD_BYTES + ZIP64_LOCATOR_BYTES : 0) +
      END_RECORD_BYTES,
  );
  const view = new DataView(output.buffer);

  let position = 0;
  for (const entry of entries) {
    const zip64Sizes = needsZip64Sizes(entry);
    const zip64Offset = entry.offset >= UINT32_MAX;
    const seconds = unixSeconds(entry.lastModified);
    const extraLength = centralExtraLength(entry);
    const { time, date } = dosDateTime(entry.lastModified);
    const version = zip64Sizes || zip64Offset ? VERSION_ZIP64 : VERSION_DEFLATE;

    view.setUint32(position, 0x02014b50, true);
    view.setUint16(position + 4, (HOST_UNIX << 8) | version, true);
    view.setUint16(position + 6, version, true);
    view.setUint16(position + 8, generalPurposeFlags(entry), true);
    view.setUint16(position + 10, entry.method, true);
    view.setUint16(position + 12, time, true);
    view.setUint16(position + 14, date, true);
    view.setUint32(position + 16, entry.crc32 >>> 0, true);
    view.setUint32(
      position + 20,
      zip64Sizes ? UINT32_MAX : entry.compressedSize,
      true,
    );
    view.setUint32(
      position + 24,
      zip64Sizes ? UINT32_MAX : entry.uncompressedSize,
      true,
    );
    view.setUint16(position + 28, entry.name.length, true);
    view.setUint16(position + 30, extraLength, true);
    // Comment length, starting disk and internal attributes stay zero.
    view.setUint32(
      position + 38,
      entry.directory ? UNIX_DIRECTORY_ATTRIBUTES : UNIX_FILE_ATTRIBUTES,
      true,
    );
    view.setUint32(
      position + 42,
      zip64Offset ? UINT32_MAX : entry.offset,
      true,
    );
    position += CENTRAL_HEADER_BYTES;
    output.set(entry.name, position);
    position += entry.name.length;

    if (zip64Sizes || zip64Offset) {
      const dataLength = (zip64Sizes ? 16 : 0) + (zip64Offset ? 8 : 0);
      view.setUint16(position, 0x0001, true);
      view.setUint16(position + 2, dataLength, true);
      position += 4;
      if (zip64Sizes) {
        setUint64(view, position, entry.uncompressedSize);
        setUint64(view, position + 8, entry.compressedSize);
        position += 16;
      }
      if (zip64Offset) {
        setUint64(view, position, entry.offset);
        position += 8;
      }
    }
    if (seconds !== null) {
      writeUnixTimeField(view, position, seconds);
      position += UNIX_TIME_FIELD_BYTES;
    }
  }

  if (zip64) {
    view.setUint32(position, 0x06064b50, true);
    setUint64(view, position + 4, ZIP64_END_RECORD_BYTES - 12);
    view.setUint16(position + 12, (HOST_UNIX << 8) | VERSION_ZIP64, true);
    view.setUint16(position + 14, VERSION_ZIP64, true);
    // Disk numbers stay zero.
    setUint64(view, position + 24, entries.length);
    setUint64(view, position + 32, entries.length);
    setUint64(view, position + 40, directoryLength);
    setUint64(view, position + 48, directoryOffset);
    position += ZIP64_END_RECORD_BYTES;

    view.setUint32(position, 0x07064b50, true);
    setUint64(view, position + 8, directoryOffset + directoryLength);
    view.setUint32(position + 16, 1, true);
    position += ZIP64_LOCATOR_BYTES;
  }

  const entryCount = Math.min(entries.length, UINT16_MAX);
  view.setUint32(position, 0x06054b50, true);
  view.setUint16(position + 8, entryCount, true);
  view.setUint16(position + 10, entryCount, true);
  view.setUint32(position + 12, Math.min(directoryLength, UINT32_MAX), true);
  view.setUint32(position + 16, Math.min(directoryOffset, UINT32_MAX), true);
  return output;
}

function centralExtraLength(entry: ZipCentralEntry): number {
  const zip64Sizes = needsZip64Sizes(entry);
  const zip64Offset = entry.offset >= UINT32_MAX;
  return (
    (zip64Sizes || zip64Offset
      ? 4 + (zip64Sizes ? 16 : 0) + (zip64Offset ? 8 : 0)
      : 0) +
    (unixSeconds(entry.lastModified) === null ? 0 : UNIX_TIME_FIELD_BYTES)
  );
}

function generalPurposeFlags(entry: ZipEntryHeader): number {
  let flags = 0;
  for (const byte of entry.name) {
    if (byte >= 0x80) {
      flags |= FLAG_UTF8;
      break;
    }
  }
  if (entry.method === ZIP_METHOD_DEFLATE) {
    // Informational deflate option bits, as written by zlib's minizip.
    if (entry.level === 1) flags |= 6;
    else if (entry.level === 2) flags |= 4;
    else if (entry.level >= 8) flags |= 2;
  }
  return flags;
}

// Info-ZIP "UT" extended timestamp carrying only the modification time.
function writeUnixTimeField(
  view: DataView,
  position: number,
  seconds: number,
): void {
  view.setUint16(position, 0x5455, true);
  view.setUint16(position + 2, 5, true);
  view.setUint8(position + 4, 1);
  view.setUint32(position + 5, seconds, true);
}

function unixSeconds(lastModified: number): number | null {
  const seconds = Math.floor(lastModified / 1000);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 0x7fffffff
    ? seconds
    : null;
}

// MS-DOS timestamps are local time with two-second resolution, 1980 to 2107.
function dosDateTime(lastModified: number): { time: number; date: number } {
  const value = new Date(lastModified);
  const year = value.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: 0x21 };
  if (year > 2107) {
    return {
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    };
  }
  return {
    time:
      (value.getHours() << 11) |
      (value.getMinutes() << 5) |
      (value.getSeconds() >> 1),
    date:
      ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function setUint64(view: DataView, position: number, value: number): void {
  view.setUint32(position, value % 0x1_0000_0000, true);
  view.setUint32(position + 4, Math.floor(value / 0x1_0000_0000), true);
}
