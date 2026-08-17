import { Writer } from "@zip.js/zip.js";

export const ZIP_ARCHIVE_SAFETY_LIMIT_ERROR =
  "The ZIP archive exceeds the browser safety limit.";

export class BoundedBlobWriter extends Writer<Blob> {
  private readonly chunks: ArrayBuffer[] = [];
  private writtenBytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    if (this.writtenBytes + array.byteLength > this.maxBytes) {
      throw new Error(ZIP_ARCHIVE_SAFETY_LIMIT_ERROR);
    }
    this.writtenBytes += array.byteLength;
    const copy = new Uint8Array(array.byteLength);
    copy.set(array);
    this.chunks.push(copy.buffer);
  }

  override async getData(): Promise<Blob> {
    return new Blob(this.chunks, { type: "application/zip" });
  }
}
