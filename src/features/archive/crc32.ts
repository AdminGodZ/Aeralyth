// Slicing-by-8 CRC-32 (IEEE 802.3, the ZIP checksum). One flat Int32Array keeps
// the eight 256-entry tables in a single typed-array load per lookup.
const TABLES = new Int32Array(8 * 256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  TABLES[index] = value;
}
for (let index = 0; index < 256; index++) {
  for (let table = 1; table < 8; table++) {
    const previous = TABLES[(table - 1) * 256 + index];
    TABLES[table * 256 + index] = (previous >>> 8) ^ TABLES[previous & 0xff];
  }
}

/**
 * Returns the unsigned CRC-32 of `data`. Pass the CRC of the preceding bytes as
 * `seed` to continue a running checksum.
 */
export function crc32(data: Uint8Array, seed = 0): number {
  const tables = TABLES;
  const length = data.length;
  let crc = ~seed;
  let offset = 0;
  const end = length - 8;
  for (; offset <= end; offset += 8) {
    const low =
      crc ^
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24));
    crc =
      tables[1792 + (low & 0xff)] ^
      tables[1536 + ((low >>> 8) & 0xff)] ^
      tables[1280 + ((low >>> 16) & 0xff)] ^
      tables[1024 + (low >>> 24)] ^
      tables[768 + data[offset + 4]] ^
      tables[512 + data[offset + 5]] ^
      tables[256 + data[offset + 6]] ^
      tables[data[offset + 7]];
  }
  for (; offset < length; offset++) {
    crc = (crc >>> 8) ^ tables[(crc ^ data[offset]) & 0xff];
  }
  return ~crc >>> 0;
}

function multiplyMatrix(matrix: Uint32Array, vector: number): number {
  let sum = 0;
  for (let index = 0; vector !== 0; index++, vector >>>= 1) {
    if (vector & 1) sum ^= matrix[index];
  }
  return sum >>> 0;
}

function squareMatrix(square: Uint32Array, matrix: Uint32Array): void {
  for (let index = 0; index < 32; index++) {
    square[index] = multiplyMatrix(matrix, matrix[index]);
  }
}

/**
 * Combines the CRC-32 of two adjacent byte ranges into the CRC-32 of their
 * concatenation (zlib's crc32_combine), so ranges of one file can be checksummed
 * independently.
 */
export function crc32Combine(
  first: number,
  second: number,
  secondLength: number,
): number {
  if (!Number.isSafeInteger(secondLength) || secondLength < 0) {
    throw new RangeError("The CRC-32 range length is invalid.");
  }
  if (secondLength === 0) return first >>> 0;

  const even = new Uint32Array(32);
  const odd = new Uint32Array(32);
  odd[0] = 0xedb88320;
  for (let index = 1; index < 32; index++) odd[index] = 2 ** (index - 1);
  squareMatrix(even, odd);
  squareMatrix(odd, even);

  let crc = first >>> 0;
  let remaining = secondLength;
  for (;;) {
    squareMatrix(even, odd);
    if (remaining % 2 === 1) crc = multiplyMatrix(even, crc);
    remaining = Math.floor(remaining / 2);
    if (remaining === 0) break;
    squareMatrix(odd, even);
    if (remaining % 2 === 1) crc = multiplyMatrix(odd, crc);
    remaining = Math.floor(remaining / 2);
    if (remaining === 0) break;
  }
  return (crc ^ second) >>> 0;
}
