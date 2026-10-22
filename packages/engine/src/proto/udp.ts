import { ByteReader } from '../bytes/reader';
import { ByteWriter } from '../bytes/writer';
import { pseudoHeaderSum, internetChecksum } from '../bytes/checksum';
import { hex16 } from '../bytes/hex';
import type { LayerNode } from '../model';
import { FieldCollector, msg } from './fields';
import { PROTO_UDP } from './ipv4';

export const UDP_HEADER_LEN = 8;

export interface UdpHeader {
  readonly srcPort: number;
  readonly dstPort: number;
}

export function encodeUdp(src: string, dst: string, h: UdpHeader, payload: Uint8Array): Uint8Array {
  const len = UDP_HEADER_LEN + payload.length;
  const w = new ByteWriter(len).u16(h.srcPort).u16(h.dstPort).u16(len).u16(0).bytes(payload);
  const seg = w.finish();
  let c = internetChecksum(seg, 0, seg.length, pseudoHeaderSum(src, dst, PROTO_UDP, len));
  if (c === 0) c = 0xffff; // RFC 768: transmitted as all ones
  w.patchU16(6, c);
  return w.finish();
}

export interface DecodedUdp {
  readonly header: UdpHeader;
  readonly checksum: number;
  readonly checksumOk: boolean;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly layer: LayerNode;
}

export function portMeaning(p: number): string {
  if (p === 53) return 'm.port.dns';
  if (p === 443) return 'm.port.https';
  return p >= 49152 ? 'm.port.ephemeral' : 'm.port';
}

export function portName(p: number): string {
  if (p === 53) return 'DNS';
  if (p === 443) return 'HTTPS';
  if (p === 80) return 'HTTP';
  return p >= 49152 ? 'ephemeral' : '';
}

export function decodeUdp(
  bytes: Uint8Array,
  start: number,
  end: number,
  src: string,
  dst: string,
): DecodedUdp {
  const r = new ByteReader(bytes, start, end);
  const srcPort = r.u16();
  const dstPort = r.u16();
  const len = r.u16();
  const checksum = r.u16();
  const segEnd = start + len;
  const checksumOk =
    checksum === 0 ||
    internetChecksum(bytes, start, segEnd, pseudoHeaderSum(src, dst, PROTO_UDP, len)) === 0;
  const fc = new FieldCollector(bytes);
  const s = start;
  fc.add('udp.sport', 'Source port', s, s + 2, String(srcPort), portMeaning(srcPort), {
    port: srcPort,
  });
  fc.add('udp.dport', 'Destination port', s + 2, s + 4, String(dstPort), portMeaning(dstPort), {
    port: dstPort,
  });
  fc.add('udp.len', 'Length', s + 4, s + 6, `${len} bytes`, 'm.udp.len', { len, payload: len - 8 });
  fc.add(
    'udp.csum',
    'Checksum',
    s + 6,
    s + 8,
    `0x${hex16(checksum)} ${checksumOk ? '✓' : '✗'}`,
    checksumOk ? 'm.udp.csum.ok' : 'm.udp.csum.bad',
    undefined,
    { expert: true },
  );
  fc.fact('ports', `${srcPort} → ${dstPort}`);
  fc.fact('len', `${len} B`, true);
  return {
    header: { srcPort, dstPort },
    checksum,
    checksumOk,
    payloadStart: start + UDP_HEADER_LEN,
    payloadEnd: segEnd,
    layer: fc.layer(
      'udp',
      'UDP',
      'transport',
      s,
      s + UDP_HEADER_LEN,
      msg('s.udp', { sport: srcPort, dport: dstPort }),
    ),
  };
}
