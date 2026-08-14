type OwnedBytes = Uint8Array<ArrayBuffer>;
type ByteAllocator = (length: number) => OwnedBytes;

export class FixedSizeBufferAssembler {
  private active: OwnedBytes | null = null;
  private offset = 0;

  constructor(
    private readonly capacity: number,
    private readonly allocate: ByteAllocator = (length) =>
      new Uint8Array(length),
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Buffer capacity must be a positive integer.");
    }
  }

  append(source: Uint8Array): OwnedBytes[] {
    const completed: OwnedBytes[] = [];
    let sourceOffset = 0;
    try {
      while (sourceOffset < source.length) {
        const active = this.active ?? this.allocateBuffer();
        const copied = Math.min(
          source.length - sourceOffset,
          this.capacity - this.offset,
        );
        active.set(
          source.subarray(sourceOffset, sourceOffset + copied),
          this.offset,
        );
        sourceOffset += copied;
        this.offset += copied;

        if (this.offset === this.capacity) {
          completed.push(active);
          this.active = null;
          this.offset = 0;
        }
      }
      return completed;
    } finally {
      source.fill(0);
    }
  }

  finish(): OwnedBytes | null {
    if (!this.active || this.offset === 0) return null;
    const final = this.active.subarray(0, this.offset);
    this.active = null;
    this.offset = 0;
    return final;
  }

  clear(): void {
    this.active?.fill(0);
    this.active = null;
    this.offset = 0;
  }

  private allocateBuffer(): OwnedBytes {
    const allocated = this.allocate(this.capacity);
    if (
      allocated.length !== this.capacity ||
      allocated.byteOffset !== 0 ||
      allocated.byteLength !== allocated.buffer.byteLength
    ) {
      allocated.fill(0);
      throw new Error("The buffer allocator returned a non-owned range.");
    }
    this.active = allocated;
    return allocated;
  }
}

export class ExactStreamReader {
  private pending: Uint8Array | null = null;
  private offset = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly allocate: ByteAllocator = (length) =>
      new Uint8Array(length),
  ) {}

  async readExactly(length: number): Promise<OwnedBytes | null> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("Read length must be a non-negative integer.");
    }
    const output = this.allocate(length);
    if (
      output.length !== length ||
      output.byteOffset !== 0 ||
      output.byteLength !== output.buffer.byteLength
    ) {
      output.fill(0);
      throw new Error("The stream allocator returned a non-owned range.");
    }
    let outputOffset = 0;

    while (outputOffset < length) {
      if (!this.pending || this.offset === this.pending.length) {
        this.pending = null;
        this.offset = 0;
        const next = await this.reader.read();
        if (next.done) {
          output.fill(0);
          return null;
        }
        if (next.value.length === 0) continue;
        this.pending = next.value;
      }

      const pending = this.pending;
      const copied = Math.min(
        length - outputOffset,
        pending.length - this.offset,
      );
      output.set(
        pending.subarray(this.offset, this.offset + copied),
        outputOffset,
      );
      pending.fill(0, this.offset, this.offset + copied);
      this.offset += copied;
      outputOffset += copied;
    }

    return output;
  }

  async isAtEnd(): Promise<boolean> {
    if (this.pending && this.offset < this.pending.length) return false;
    const next = await this.reader.read();
    if (next.done) return true;
    next.value.fill(0);
    return false;
  }

  async cancel(): Promise<void> {
    this.pending?.fill(0);
    this.pending = null;
    this.offset = 0;
    await this.reader.cancel().catch(() => undefined);
  }
}
