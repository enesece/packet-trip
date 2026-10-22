import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter } from '../bytes/writer';
import { internetChecksum, pseudoHeaderSum } from '../bytes/checksum';
import { hex16 } from '../bytes/hex';
import type { Field, LayerNode } from '../model';
import { FieldCollector, msg } from './fields';
import { PROTO_TCP } from './ipv4';
import { portMeaning } from './udp';

export const TCP_HEADER_LEN = 20;

export interface TcpFlags {
  readonly fin: boolean;
  readonly syn: boolean;
  readonly rst: boolean;
  readonly psh: boolean;
  readonly ack: boolean;
  readonly urg: boolean;
  readonly ece: boolean;
  readonly cwr: boolean;
}

export const NO_FLAGS: TcpFlags = {
  fin: false,
  syn: false,
  rst: false,
  psh: false,
  ack: false,
  urg: false,
  ece: false,
  cwr: false,
};

export function flags(partial: Partial<TcpFlags>): TcpFlags {
  return { ...NO_FLAGS, ...partial };
}

export type TcpOption =
  | { readonly kind: 'eol' }
  | { readonly kind: 'nop' }
  | { readonly kind: 'mss'; readonly value: number }
  | { readonly kind: 'wscale'; readonly shift: number }
  | { readonly kind: 'sack-permitted' }
  | { readonly kind: 'sack'; readonly blocks: readonly (readonly [number, number])[] };

export interface TcpHeader {
  readonly srcPort: number;
  readonly dstPort: number;
  readonly seq: number;
  readonly ack: number;
  readonly flags: TcpFlags;
  readonly window: number;
  readonly urgent: number;
  readonly options: readonly TcpOption[];
}

export function flagBits(f: TcpFlags): number {
  return (
    (f.fin ? 0x01 : 0) |
    (f.syn ? 0x02 : 0) |
    (f.rst ? 0x04 : 0) |
    (f.psh ? 0x08 : 0) |
    (f.ack ? 0x10 : 0) |
    (f.urg ? 0x20 : 0) |
    (f.ece ? 0x40 : 0) |
    (f.cwr ? 0x80 : 0)
  );
}

export function parseFlagBits(b: number): TcpFlags {
  return {
    fin: (b & 0x01) !== 0,
    syn: (b & 0x02) !== 0,
    rst: (b & 0x04) !== 0,
    psh: (b & 0x08) !== 0,
    ack: (b & 0x10) !== 0,
    urg: (b & 0x20) !== 0,
    ece: (b & 0x40) !== 0,
    cwr: (b & 0x80) !== 0,
  };
}

export function flagNames(f: TcpFlags): string[] {
  const out: string[] = [];
  if (f.syn) out.push('SYN');
  if (f.fin) out.push('FIN');
  if (f.rst) out.push('RST');
  if (f.psh) out.push('PSH');
  if (f.ack) out.push('ACK');
  if (f.urg) out.push('URG');
  if (f.ece) out.push('ECE');
  if (f.cwr) out.push('CWR');
  return out;
}

function encodeOptions(opts: readonly TcpOption[]): Uint8Array {
  const w = new ByteWriter(40);
  for (const o of opts) {
    switch (o.kind) {
      case 'eol':
        w.u8(0);
        break;
      case 'nop':
        w.u8(1);
        break;
      case 'mss':
        w.u8(2).u8(4).u16(o.value);
        break;
      case 'wscale':
        w.u8(3).u8(3).u8(o.shift);
        break;
      case 'sack-permitted':
        w.u8(4).u8(2);
        break;
      case 'sack':
        w.u8(5).u8(2 + 8 * o.blocks.length);
        for (const [l, r] of o.blocks) w.u32(l).u32(r);
        break;
    }
  }
  if (w.length % 4 !== 0) throw new Error('TCP options must be padded to a multiple of 4 bytes');
  if (w.length > 40) throw new Error('TCP options too long');
  return w.finish();
}

export function encodeTcp(src: string, dst: string, h: TcpHeader, payload: Uint8Array): Uint8Array {
  const opts = encodeOptions(h.options);
  const hlen = TCP_HEADER_LEN + opts.length;
  const w = new ByteWriter(hlen + payload.length)
    .u16(h.srcPort)
    .u16(h.dstPort)
    .u32(h.seq >>> 0)
    .u32(h.ack >>> 0)
    .u8((hlen / 4) << 4)
    .u8(flagBits(h.flags))
    .u16(h.window)
    .u16(0)
    .u16(h.urgent)
    .bytes(opts)
    .bytes(payload);
  const seg = w.finish();
  const c = internetChecksum(seg, 0, seg.length, pseudoHeaderSum(src, dst, PROTO_TCP, seg.length));
  w.patchU16(16, c);
  return w.finish();
}

export interface DecodedTcp {
  readonly header: TcpHeader;
  readonly checksum: number;
  readonly checksumOk: boolean;
  readonly headerLen: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly layer: LayerNode;
}

export interface TcpDecodeContext {
  /** Relative sequence numbers like Wireshark shows, if the ISNs are known. */
  readonly isnSrc?: number;
  readonly isnDst?: number;
  readonly windowScaleSrc?: number;
}

export function decodeTcp(
  bytes: Uint8Array,
  start: number,
  end: number,
  src: string,
  dst: string,
  ctx: TcpDecodeContext = {},
): DecodedTcp {
  const r = new ByteReader(bytes, start, end);
  const srcPort = r.u16();
  const dstPort = r.u16();
  const seq = r.u32();
  const ack = r.u32();
  const offByte = r.u8();
  const hlen = (offByte >> 4) * 4;
  if (hlen < TCP_HEADER_LEN) throw new DecodeError(`bad TCP data offset ${hlen}`);
  const flagByte = r.u8();
  const window = r.u16();
  const checksum = r.u16();
  const urgent = r.u16();
  const fl = parseFlagBits(flagByte);
  const options: TcpOption[] = [];
  const optFields: Field[] = [];
  const fc = new FieldCollector(bytes);
  const optEnd = start + hlen;
  while (r.offset < optEnd) {
    const o = r.offset;
    const kind = r.u8();
    if (kind === 0) {
      options.push({ kind: 'eol' });
      optFields.push(fc.make('tcp.opt.eol', 'End of options', o, o + 1, 'EOL', 'm.tcp.opt.eol'));
      continue;
    }
    if (kind === 1) {
      options.push({ kind: 'nop' });
      optFields.push(fc.make('tcp.opt.nop', 'No-op (padding)', o, o + 1, 'NOP', 'm.tcp.opt.nop'));
      continue;
    }
    const len = r.u8();
    if (len < 2 || o + len > optEnd) throw new DecodeError(`bad TCP option length ${len}`);
    if (kind === 2 && len === 4) {
      const value = r.u16();
      options.push({ kind: 'mss', value });
      optFields.push(
        fc.make(
          'tcp.opt.mss',
          'Maximum segment size',
          o,
          o + 4,
          `${value} bytes`,
          'm.tcp.opt.mss',
          { value },
        ),
      );
    } else if (kind === 3 && len === 3) {
      const shift = r.u8();
      options.push({ kind: 'wscale', shift });
      optFields.push(
        fc.make(
          'tcp.opt.ws',
          'Window scale',
          o,
          o + 3,
          `×${2 ** shift} (shift ${shift})`,
          'm.tcp.opt.ws',
          {
            shift,
            mult: 2 ** shift,
          },
        ),
      );
    } else if (kind === 4 && len === 2) {
      options.push({ kind: 'sack-permitted' });
      optFields.push(
        fc.make('tcp.opt.sackp', 'SACK permitted', o, o + 2, 'yes', 'm.tcp.opt.sackp'),
      );
    } else if (kind === 5 && (len - 2) % 8 === 0) {
      const blocks: [number, number][] = [];
      for (let i = 0; i < (len - 2) / 8; i++) blocks.push([r.u32(), r.u32()]);
      options.push({ kind: 'sack', blocks });
      optFields.push(
        fc.make(
          'tcp.opt.sack',
          'SACK blocks',
          o,
          o + len,
          blocks.map(([a, b]) => `${a}–${b}`).join(', '),
          'm.tcp.opt.sack',
        ),
      );
    } else {
      throw new DecodeError(`unsupported TCP option kind ${kind}`);
    }
  }
  const segLen = end - start;
  const checksumOk =
    internetChecksum(bytes, start, end, pseudoHeaderSum(src, dst, PROTO_TCP, segLen)) === 0;
  const payloadLen = end - start - hlen;
  const s = start;
  const relSeq = ctx.isnSrc !== undefined ? (seq - ctx.isnSrc) >>> 0 : null;
  const relAck = fl.ack && ctx.isnDst !== undefined ? (ack - ctx.isnDst) >>> 0 : null;
  fc.add('tcp.sport', 'Source port', s, s + 2, String(srcPort), portMeaning(srcPort), {
    port: srcPort,
  });
  fc.add('tcp.dport', 'Destination port', s + 2, s + 4, String(dstPort), portMeaning(dstPort), {
    port: dstPort,
  });
  fc.add(
    'tcp.seq',
    'Sequence number',
    s + 4,
    s + 8,
    relSeq !== null ? `${seq} (relative ${relSeq})` : String(seq),
    fl.syn ? 'm.tcp.seq.syn' : 'm.tcp.seq',
    { seq, rel: relSeq ?? seq, len: payloadLen },
    { expert: true },
  );
  fc.add(
    'tcp.ack',
    'Acknowledgment number',
    s + 8,
    s + 12,
    fl.ack ? (relAck !== null ? `${ack} (relative ${relAck})` : String(ack)) : `${ack} (unused)`,
    fl.ack ? 'm.tcp.ack' : 'm.tcp.ack.unused',
    { ack, rel: relAck ?? ack },
    { expert: true },
  );
  const names = flagNames(fl);
  fc.add(
    'tcp.off',
    'Header length',
    s + 12,
    s + 13,
    `${hlen} bytes`,
    'm.tcp.off',
    { hlen },
    { expert: true },
  );
  fc.add('tcp.flags', 'Flags', s + 13, s + 14, names.join(', ') || 'none', flagMeaning(fl), {
    flags: names.join(', '),
  });
  const scale = ctx.windowScaleSrc;
  fc.add(
    'tcp.win',
    'Window',
    s + 14,
    s + 16,
    scale !== undefined && !fl.syn
      ? `${window} (×${2 ** scale} = ${window * 2 ** scale})`
      : String(window),
    'm.tcp.win',
    { win: scale !== undefined && !fl.syn ? window * 2 ** scale : window },
  );
  fc.add(
    'tcp.csum',
    'Checksum',
    s + 16,
    s + 18,
    `0x${hex16(checksum)} ${checksumOk ? '✓' : '✗'}`,
    checksumOk ? 'm.tcp.csum.ok' : 'm.tcp.csum.bad',
    undefined,
    { expert: true },
  );
  fc.add('tcp.urg', 'Urgent pointer', s + 18, s + 20, String(urgent), 'm.tcp.urg', undefined, {
    expert: true,
  });
  if (optFields.length > 0) {
    fc.add('tcp.opts', 'Options', s + 20, s + hlen, `${hlen - 20} bytes`, 'm.tcp.opts', undefined, {
      children: optFields,
    });
  }
  fc.fact('ports', `${srcPort} → ${dstPort}`);
  fc.fact('flags', names.join(', ') || '—');
  fc.fact('seq', relSeq !== null ? String(relSeq) : String(seq), true);
  if (fl.ack) fc.fact('ack', relAck !== null ? String(relAck) : String(ack), true);
  if (payloadLen > 0) fc.fact('data', `${payloadLen} B`);
  return {
    header: { srcPort, dstPort, seq, ack, flags: fl, window, urgent, options },
    checksum,
    checksumOk,
    headerLen: hlen,
    payloadStart: start + hlen,
    payloadEnd: end,
    layer: fc.layer(
      'tcp',
      'TCP',
      'transport',
      s,
      s + hlen,
      msg('s.tcp', {
        sport: srcPort,
        dport: dstPort,
        flags: names.join(', ') || '—',
        len: payloadLen,
      }),
    ),
  };
}

function flagMeaning(f: TcpFlags): string {
  if (f.syn && f.ack) return 'm.tcp.flags.synack';
  if (f.syn) return 'm.tcp.flags.syn';
  if (f.fin) return 'm.tcp.flags.fin';
  if (f.rst) return 'm.tcp.flags.rst';
  if (f.psh) return 'm.tcp.flags.psh';
  return 'm.tcp.flags.ack';
}
