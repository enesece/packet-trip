/** Growable big-endian byte writer used by every protocol encoder. */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialSize = 256) {
    this.buf = new Uint8Array(initialSize);
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u24(v: number): this {
    this.ensure(3);
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  ascii(s: string): this {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
    return this;
  }

  /** Overwrite a 16-bit value at an absolute offset (used for lengths and checksums). */
  patchU16(offset: number, v: number): this {
    this.buf[offset] = (v >>> 8) & 0xff;
    this.buf[offset + 1] = v & 0xff;
    return this;
  }

  patchU24(offset: number, v: number): this {
    this.buf[offset] = (v >>> 16) & 0xff;
    this.buf[offset + 1] = (v >>> 8) & 0xff;
    this.buf[offset + 2] = v & 0xff;
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToAscii(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

/** UTF-8 encode without relying on TextEncoder typings. */
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = Math.min(c, 0x10ffff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i] ?? 0;
    let cp = 0xfffd;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc0 && c < 0xe0 && i + 1 < b.length) {
      cp = ((c & 31) << 6) | ((b[i + 1] ?? 0) & 63);
      n = 2;
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < b.length) {
      cp = ((c & 15) << 12) | (((b[i + 1] ?? 0) & 63) << 6) | ((b[i + 2] ?? 0) & 63);
      n = 3;
    } else if (c >= 0xf0 && i + 3 < b.length) {
      cp =
        ((c & 7) << 18) |
        (((b[i + 1] ?? 0) & 63) << 12) |
        (((b[i + 2] ?? 0) & 63) << 6) |
        ((b[i + 3] ?? 0) & 63);
      n = 4;
    }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
