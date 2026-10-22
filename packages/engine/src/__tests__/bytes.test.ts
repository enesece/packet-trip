import { describe, expect, it } from 'vitest';
import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter, utf8Bytes, utf8Decode } from '../bytes/writer';
import { internetChecksum, onesSum, pseudoHeaderSum } from '../bytes/checksum';
import { fromHex, hexRows, toHex } from '../bytes/hex';

describe('internet checksum', () => {
  it('matches the RFC 1071 worked example', () => {
    const b = fromHex('0001 f203 f4f5 f6f7');
    expect(onesSum(b).toString(16)).toBe('ddf2');
    expect(internetChecksum(b)).toBe(0x220d);
  });

  it('handles odd lengths by padding with a zero byte', () => {
    expect(internetChecksum(fromHex('01'))).toBe(~0x0100 & 0xffff);
  });

  it('verifies to zero when the checksum is included', () => {
    const b = fromHex('4500 0073 0000 4000 4011 b861 c0a8 0001 c0a8 00c7');
    expect(internetChecksum(b)).toBe(0);
  });

  it('computes the pseudo-header sum', () => {
    // 10.0.0.1 → 10.0.0.2, UDP, length 10
    expect(pseudoHeaderSum('10.0.0.1', '10.0.0.2', 17, 10)).toBe(
      0x0a00 + 0x0001 + 0x0a00 + 0x0002 + 17 + 10,
    );
  });
});

describe('writer and reader', () => {
  it('round-trips big-endian integers', () => {
    const b = new ByteWriter(2).u8(0xab).u16(0x1234).u24(0x56789a).u32(0xdeadbeef).finish();
    expect(toHex(b, 0, b.length, '')).toBe('ab123456789adeadbeef');
    const r = new ByteReader(b);
    expect([r.u8(), r.u16(), r.u24(), r.u32()]).toEqual([0xab, 0x1234, 0x56789a, 0xdeadbeef]);
    expect(r.remaining).toBe(0);
  });

  it('throws a DecodeError when reading past the end', () => {
    expect(() => new ByteReader(Uint8Array.of(1)).u16()).toThrow(DecodeError);
  });

  it('patches 16-bit values in place', () => {
    const w = new ByteWriter().u16(0).u8(7);
    w.patchU16(0, 0xbeef);
    expect(toHex(w.finish(), 0, 3, '')).toBe('beef07');
  });

  it('encodes UTF-8 like TextEncoder', () => {
    const s = 'Köln — 東京 🚀';
    expect(Array.from(utf8Bytes(s))).toEqual(Array.from(new TextEncoder().encode(s)));
    expect(utf8Decode(utf8Bytes(s))).toBe(s);
  });

  it('splits hex rows of 16 bytes', () => {
    const rows = hexRows(new Uint8Array(40));
    expect(rows.map((r) => [r.offset, r.bytes.length])).toEqual([
      [0, 16],
      [16, 16],
      [32, 8],
    ]);
  });
});
