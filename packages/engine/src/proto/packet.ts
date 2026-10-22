import type { LayerNode } from '../model';
import { bytesEqual, concatBytes } from '../bytes/writer';
import { ETHERTYPE_IPV4, decodeEthernet, encodeEthernet, type EthernetHeader } from './ethernet';
import { PROTO_TCP, PROTO_UDP, decodeIpv4, encodeIpv4, type Ipv4Header } from './ipv4';
import { decodeUdp, encodeUdp, type UdpHeader } from './udp';
import { decodeTcp, encodeTcp, type TcpDecodeContext, type TcpHeader } from './tcp';
import { decodeDns, encodeDns } from './dns';
import { decodeTlsFragment, type FragmentSpan, type TlsFragmentResult } from './tls-fragment';
import type { DecryptedRecord } from '../model';

export type FrameL4 =
  | { readonly kind: 'udp'; readonly header: UdpHeader }
  | { readonly kind: 'tcp'; readonly header: TcpHeader };

export interface FrameSpec {
  readonly eth: EthernetHeader;
  readonly ip: Omit<Ipv4Header, 'protocol'>;
  readonly l4: FrameL4;
  readonly payload: Uint8Array;
}

export function encodeFrame(f: FrameSpec): Uint8Array {
  const l4 =
    f.l4.kind === 'udp'
      ? encodeUdp(f.ip.src, f.ip.dst, f.l4.header, f.payload)
      : encodeTcp(f.ip.src, f.ip.dst, f.l4.header, f.payload);
  const ip = encodeIpv4({ ...f.ip, protocol: f.l4.kind === 'udp' ? PROTO_UDP : PROTO_TCP }, l4);
  return encodeEthernet(f.eth, ip);
}

export interface DecodeContext {
  readonly macNames?: Readonly<Record<string, string>>;
  readonly hostNames?: Readonly<Record<string, string>>;
  readonly tcp?: TcpDecodeContext;
  /** TLS stream info for TCP payloads (absolute offsets already resolved). */
  readonly tls?: { readonly spans: readonly FragmentSpan[]; readonly version: '1.2' | '1.3' };
}

export interface DecodedFrame {
  readonly spec: FrameSpec;
  readonly layers: LayerNode[];
  readonly decrypted: DecryptedRecord[];
  readonly checks: { readonly ipv4: boolean; readonly l4: boolean };
  readonly app: {
    readonly kind: 'dns' | 'tls' | 'none';
    readonly ok: boolean;
    readonly name?: string;
  };
}

/** Parses a frame into its layers. Each layer keeps its byte range so hex and fields stay in sync. */
export function decodeFrame(bytes: Uint8Array, ctx: DecodeContext = {}): DecodedFrame {
  const eth = decodeEthernet(bytes, ctx.macNames);
  if (eth.header.etherType !== ETHERTYPE_IPV4) throw new Error('not an IPv4 frame');
  const ip = decodeIpv4(bytes, eth.payloadStart, ctx.hostNames);
  const layers: LayerNode[] = [
    { ...eth.layer, depth: 0 },
    { ...ip.layer, depth: 1 },
  ];
  const decrypted: DecryptedRecord[] = [];
  let l4: FrameL4;
  let l4ok: boolean;
  let payloadStart: number;
  let app: DecodedFrame['app'] = { kind: 'none', ok: true };
  if (ip.header.protocol === PROTO_UDP) {
    const u = decodeUdp(bytes, ip.payloadStart, ip.payloadEnd, ip.header.src, ip.header.dst);
    layers.push({ ...u.layer, depth: 2 });
    l4 = { kind: 'udp', header: u.header };
    l4ok = u.checksumOk;
    payloadStart = u.payloadStart;
    if (u.header.srcPort === 53 || u.header.dstPort === 53) {
      const d = decodeDns(bytes, u.payloadStart, u.payloadEnd);
      layers.push({ ...d.layer, depth: 3 });
      const again = encodeDns(d.message);
      app = {
        kind: 'dns',
        ok: bytesEqual(again, bytes.subarray(u.payloadStart, u.payloadEnd)),
        name: d.message.questions[0]?.name ?? '',
      };
    }
  } else if (ip.header.protocol === PROTO_TCP) {
    const t = decodeTcp(
      bytes,
      ip.payloadStart,
      ip.payloadEnd,
      ip.header.src,
      ip.header.dst,
      ctx.tcp,
    );
    layers.push({ ...t.layer, depth: 2 });
    l4 = { kind: 'tcp', header: t.header };
    l4ok = t.checksumOk;
    payloadStart = t.payloadStart;
    if (ctx.tls && t.payloadEnd > t.payloadStart) {
      const r: TlsFragmentResult = decodeTlsFragment(
        bytes,
        t.payloadStart,
        t.payloadEnd,
        ctx.tls.spans,
        ctx.tls.version,
      );
      layers.push(...r.layers);
      decrypted.push(...r.decrypted);
      app = {
        kind: 'tls',
        ok: bytesEqual(concatBytes(r.pieces), bytes.subarray(t.payloadStart, t.payloadEnd)),
      };
    }
  } else {
    throw new Error(`unsupported IP protocol ${ip.header.protocol}`);
  }
  const { protocol: _p, ...ipRest } = ip.header;
  void _p;
  return {
    spec: { eth: eth.header, ip: ipRest, l4, payload: bytes.slice(payloadStart, ip.payloadEnd) },
    layers,
    decrypted,
    checks: { ipv4: ip.checksumOk, l4: l4ok },
    app,
  };
}
