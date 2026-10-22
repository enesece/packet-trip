import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter } from '../bytes/writer';
import { bytesToIp, internetChecksum, ipToBytes } from '../bytes/checksum';
import { hex16, hex8 } from '../bytes/hex';
import type { LayerNode } from '../model';
import { FieldCollector, msg } from './fields';

export const IPV4_HEADER_LEN = 20;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;

export interface Ipv4Header {
  readonly dscp: number;
  readonly id: number;
  readonly df: boolean;
  readonly ttl: number;
  readonly protocol: number;
  readonly src: string;
  readonly dst: string;
}

export function encodeIpv4(h: Ipv4Header, payload: Uint8Array): Uint8Array {
  const total = IPV4_HEADER_LEN + payload.length;
  if (total > 0xffff) throw new Error('IPv4 packet too large');
  const w = new ByteWriter(total);
  w.u8(0x45) // version 4, IHL 5 (20 bytes)
    .u8(h.dscp)
    .u16(total)
    .u16(h.id)
    .u16(h.df ? 0x4000 : 0)
    .u8(h.ttl)
    .u8(h.protocol)
    .u16(0) // checksum placeholder
    .bytes(ipToBytes(h.src))
    .bytes(ipToBytes(h.dst));
  const header = w.finish();
  const csum = internetChecksum(header, 0, IPV4_HEADER_LEN);
  w.patchU16(10, csum);
  w.bytes(payload);
  return w.finish();
}

export interface DecodedIpv4 {
  readonly header: Ipv4Header;
  readonly checksum: number;
  readonly checksumOk: boolean;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly layer: LayerNode;
}

const PROTO_NAMES: Record<number, string> = { 6: 'TCP', 17: 'UDP', 1: 'ICMP' };

export function decodeIpv4(
  bytes: Uint8Array,
  start: number,
  hostNames: Readonly<Record<string, string>> = {},
): DecodedIpv4 {
  const r = new ByteReader(bytes, start);
  const vihl = r.u8();
  const version = vihl >> 4;
  const ihl = vihl & 15;
  if (version !== 4) throw new DecodeError(`not IPv4 (version ${version})`);
  if (ihl !== 5) throw new DecodeError(`IPv4 options are not supported (IHL ${ihl})`);
  const dscp = r.u8();
  const total = r.u16();
  const id = r.u16();
  const flagsFrag = r.u16();
  const ttl = r.u8();
  const protocol = r.u8();
  const checksum = r.u16();
  const src = bytesToIp(r.bytes(4));
  const dst = bytesToIp(r.bytes(4));
  if (start + total > bytes.length) throw new DecodeError('IPv4 total length exceeds frame');
  const checksumOk = internetChecksum(bytes, start, start + IPV4_HEADER_LEN) === 0;
  const df = (flagsFrag & 0x4000) !== 0;
  const fragOffset = flagsFrag & 0x1fff;
  if ((flagsFrag & 0x2000) !== 0 || fragOffset !== 0) {
    throw new DecodeError('fragmented IPv4 packets are not supported');
  }

  const fc = new FieldCollector(bytes, 0);
  const s = start;
  fc.add(
    'ipv4.vihl',
    'Version · header length',
    s,
    s + 1,
    `4 · ${ihl * 4} bytes`,
    'm.ipv4.vihl',
    undefined,
    {
      expert: true,
    },
  );
  fc.add('ipv4.dscp', 'DSCP / ECN', s + 1, s + 2, `0x${hex8(dscp)}`, 'm.ipv4.dscp', undefined, {
    expert: true,
  });
  fc.add('ipv4.len', 'Total length', s + 2, s + 4, `${total} bytes`, 'm.ipv4.len', {
    total,
    payload: total - 20,
  });
  fc.add(
    'ipv4.id',
    'Identification',
    s + 4,
    s + 6,
    `0x${hex16(id)} (${id})`,
    'm.ipv4.id',
    undefined,
    {
      expert: true,
    },
  );
  fc.add(
    'ipv4.flags',
    'Flags · fragment offset',
    s + 6,
    s + 8,
    df ? 'DF · 0' : '0 · 0',
    df ? 'm.ipv4.df' : 'm.ipv4.nodf',
    undefined,
    {
      expert: true,
    },
  );
  const hops = 64 - ttl;
  fc.add(
    'ipv4.ttl',
    'Time to live',
    s + 8,
    s + 9,
    String(ttl),
    hops > 0 ? 'm.ipv4.ttl.hops' : 'm.ipv4.ttl',
    {
      ttl,
      hops,
    },
  );
  fc.add(
    'ipv4.proto',
    'Protocol',
    s + 9,
    s + 10,
    `${protocol} (${PROTO_NAMES[protocol] ?? '?'})`,
    'm.ipv4.proto',
    { name: PROTO_NAMES[protocol] ?? '?' },
  );
  fc.add(
    'ipv4.csum',
    'Header checksum',
    s + 10,
    s + 12,
    `0x${hex16(checksum)} ${checksumOk ? '✓' : '✗'}`,
    checksumOk ? 'm.ipv4.csum.ok' : 'm.ipv4.csum.bad',
    undefined,
    { expert: true },
  );
  fc.add('ipv4.src', 'Source address', s + 12, s + 16, src, 'm.ipv4.src', {
    who: hostNames[src] ?? src,
  });
  fc.add('ipv4.dst', 'Destination address', s + 16, s + 20, dst, 'm.ipv4.dst', {
    who: hostNames[dst] ?? dst,
  });
  fc.fact('src', src);
  fc.fact('dst', dst);
  fc.fact('TTL', String(ttl));
  fc.fact('len', `${total} B`, true);
  fc.fact('checksum', `0x${hex16(checksum)}${checksumOk ? ' ✓' : ' ✗'}`, true);
  const layer = fc.layer(
    'ipv4',
    'IPv4',
    'network',
    s,
    s + IPV4_HEADER_LEN,
    msg('s.ipv4', { src, dst, ttl }),
  );
  return {
    header: { dscp, id, df, ttl, protocol, src, dst },
    checksum,
    checksumOk,
    payloadStart: start + IPV4_HEADER_LEN,
    payloadEnd: start + total,
    layer,
  };
}
