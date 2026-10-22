export class DecodeError extends Error {
  override name = 'DecodeError';
}

/** Bounds-checked big-endian reader. Every decoder reads through one of these. */
export class ByteReader {
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get limit(): number {
    return this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new DecodeError(
        `need ${n} bytes at offset ${this.pos}, only ${this.end - this.pos} left`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++] ?? 0;
  }

  u16(): number {
    this.need(2);
    const v = ((this.buf[this.pos] ?? 0) << 8) | (this.buf[this.pos + 1] ?? 0);
    this.pos += 2;
    return v;
  }

  u24(): number {
    this.need(3);
    const v =
      ((this.buf[this.pos] ?? 0) << 16) |
      ((this.buf[this.pos + 1] ?? 0) << 8) |
      (this.buf[this.pos + 2] ?? 0);
    this.pos += 3;
    return v;
  }

  u32(): number {
    this.need(4);
    const v =
      (((this.buf[this.pos] ?? 0) << 24) >>> 0) +
      (((this.buf[this.pos + 1] ?? 0) << 16) |
        ((this.buf[this.pos + 2] ?? 0) << 8) |
        (this.buf[this.pos + 3] ?? 0));
    this.pos += 4;
    return v >>> 0;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }

  peekU8(at = this.pos): number {
    if (at >= this.end) throw new DecodeError(`peek past end at ${at}`);
    return this.buf[at] ?? 0;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.end) throw new DecodeError(`seek out of range ${offset}`);
    this.pos = offset;
  }

  /** A child reader over the next n bytes; advances this reader past them. */
  sub(n: number): ByteReader {
    this.need(n);
    const r = new ByteReader(this.buf, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }

  get source(): Uint8Array {
    return this.buf;
  }
}
