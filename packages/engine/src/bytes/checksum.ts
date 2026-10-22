/** RFC 1071 Internet checksum helpers. */

/** One's-complement sum of 16-bit words (not yet inverted). */
export function onesSum(bytes: Uint8Array, start = 0, end = bytes.length, initial = 0): number {
  let sum = initial;
  let i = start;
  for (; i + 1 < end; i += 2) sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  if (i < end) sum += (bytes[i] ?? 0) << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum;
}

export function internetChecksum(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
  initial = 0,
): number {
  return ~onesSum(bytes, start, end, initial) & 0xffff;
}

export function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) {
    throw new Error(`bad IPv4 address ${ip}`);
  }
  return Uint8Array.from(parts);
}

export function bytesToIp(b: Uint8Array, at = 0): string {
  return `${b[at] ?? 0}.${b[at + 1] ?? 0}.${b[at + 2] ?? 0}.${b[at + 3] ?? 0}`;
}

/** Sum of the IPv4 pseudo-header used by TCP and UDP checksums. */
export function pseudoHeaderSum(
  src: string,
  dst: string,
  protocol: number,
  length: number,
): number {
  const s = ipToBytes(src);
  const d = ipToBytes(dst);
  let sum = 0;
  sum += ((s[0] ?? 0) << 8) | (s[1] ?? 0);
  sum += ((s[2] ?? 0) << 8) | (s[3] ?? 0);
  sum += ((d[0] ?? 0) << 8) | (d[1] ?? 0);
  sum += ((d[2] ?? 0) << 8) | (d[3] ?? 0);
  sum += protocol;
  sum += length;
  return sum;
}

/** Checksum of a transport segment (with its checksum field already in place) — 0 means valid. */
export function transportChecksum(
  src: string,
  dst: string,
  protocol: number,
  segment: Uint8Array,
): number {
  return internetChecksum(
    segment,
    0,
    segment.length,
    pseudoHeaderSum(src, dst, protocol, segment.length),
  );
}
