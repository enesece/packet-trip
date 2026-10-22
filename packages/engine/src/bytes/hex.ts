export function hex8(v: number): string {
  return (v & 0xff).toString(16).padStart(2, '0');
}

export function hex16(v: number): string {
  return (v & 0xffff).toString(16).padStart(4, '0');
}

export function hex32(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

/** Lowercase hex string with a separator between bytes. */
export function toHex(b: Uint8Array, start = 0, end = b.length, sep = ' '): string {
  const out: string[] = [];
  for (let i = start; i < end; i++) out.push(hex8(b[i] ?? 0));
  return out.join(sep);
}

/** Short hex preview: the first `max` bytes, with an ellipsis when truncated. */
export function hexPreview(b: Uint8Array, start: number, end: number, max = 8): string {
  const n = end - start;
  if (n <= max) return toHex(b, start, end);
  return `${toHex(b, start, start + max)} …`;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface HexRow {
  readonly offset: number;
  readonly bytes: readonly number[];
}

export function hexRows(b: Uint8Array, perRow = 16): HexRow[] {
  const rows: HexRow[] = [];
  for (let o = 0; o < b.length; o += perRow) {
    rows.push({ offset: o, bytes: Array.from(b.subarray(o, Math.min(o + perRow, b.length))) });
  }
  return rows;
}

export function macToBytes(mac: string): Uint8Array {
  const parts = mac.split(':').map((p) => Number.parseInt(p, 16));
  if (parts.length !== 6 || parts.some((p) => !(p >= 0 && p <= 255))) {
    throw new Error(`bad MAC ${mac}`);
  }
  return Uint8Array.from(parts);
}

export function bytesToMac(b: Uint8Array, at = 0): string {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(hex8(b[at + i] ?? 0));
  return out.join(':');
}
