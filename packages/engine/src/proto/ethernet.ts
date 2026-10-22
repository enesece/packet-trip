import { ByteReader } from '../bytes/reader';
import { ByteWriter } from '../bytes/writer';
import { bytesToMac, hex16, macToBytes } from '../bytes/hex';
import type { LayerNode } from '../model';
import { FieldCollector, msg } from './fields';

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERNET_HEADER_LEN = 14;

export interface EthernetHeader {
  readonly dst: string;
  readonly src: string;
  readonly etherType: number;
}

export function encodeEthernet(h: EthernetHeader, payload: Uint8Array): Uint8Array {
  return new ByteWriter(ETHERNET_HEADER_LEN + payload.length)
    .bytes(macToBytes(h.dst))
    .bytes(macToBytes(h.src))
    .u16(h.etherType)
    .bytes(payload)
    .finish();
}

export interface DecodedEthernet {
  readonly header: EthernetHeader;
  readonly payloadStart: number;
  readonly layer: LayerNode;
}

export function decodeEthernet(
  bytes: Uint8Array,
  macNames: Readonly<Record<string, string>> = {},
): DecodedEthernet {
  const r = new ByteReader(bytes);
  r.bytes(6);
  r.bytes(6);
  const etherType = r.u16();
  const dst = bytesToMac(bytes, 0);
  const src = bytesToMac(bytes, 6);
  const fc = new FieldCollector(bytes);
  const dstName = macNames[dst] ?? '';
  const srcName = macNames[src] ?? '';
  fc.add('eth.dst', 'Destination MAC', 0, 6, dst, 'm.eth.dst', { who: dstName });
  fc.add('eth.src', 'Source MAC', 6, 12, src, 'm.eth.src', { who: srcName });
  fc.add(
    'eth.type',
    'EtherType',
    12,
    14,
    `0x${hex16(etherType)}${etherType === ETHERTYPE_IPV4 ? ' (IPv4)' : ''}`,
    'm.eth.type',
  );
  fc.fact('src', srcName ? `${srcName} · ${src}` : src);
  fc.fact('dst', dstName ? `${dstName} · ${dst}` : dst);
  const layer = fc.layer(
    'eth',
    'Wi-Fi',
    'link',
    0,
    ETHERNET_HEADER_LEN,
    msg('s.eth', { src: srcName || src, dst: dstName || dst }),
  );
  return { header: { dst, src, etherType }, payloadStart: ETHERNET_HEADER_LEN, layer };
}
