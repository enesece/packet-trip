import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter } from '../bytes/writer';
import { bytesToIp, ipToBytes } from '../bytes/checksum';
import { hex16 } from '../bytes/hex';
import type { Field, LayerNode } from '../model';
import { FieldCollector, msg } from './fields';

export const DNS_TYPE_A = 1;
export const DNS_TYPE_NS = 2;
export const DNS_CLASS_IN = 1;

export interface DnsFlags {
  readonly qr: boolean;
  readonly opcode: number;
  readonly aa: boolean;
  readonly tc: boolean;
  readonly rd: boolean;
  readonly ra: boolean;
  readonly rcode: number;
}

export function packDnsFlags(f: DnsFlags): number {
  return (
    (f.qr ? 0x8000 : 0) |
    ((f.opcode & 15) << 11) |
    (f.aa ? 0x0400 : 0) |
    (f.tc ? 0x0200 : 0) |
    (f.rd ? 0x0100 : 0) |
    (f.ra ? 0x0080 : 0) |
    (f.rcode & 15)
  );
}

export function unpackDnsFlags(v: number): DnsFlags {
  return {
    qr: (v & 0x8000) !== 0,
    opcode: (v >> 11) & 15,
    aa: (v & 0x0400) !== 0,
    tc: (v & 0x0200) !== 0,
    rd: (v & 0x0100) !== 0,
    ra: (v & 0x0080) !== 0,
    rcode: v & 15,
  };
}

export interface DnsQuestion {
  readonly name: string;
  readonly type: number;
  readonly cls: number;
}

export type DnsRData =
  | { readonly kind: 'A'; readonly address: string }
  | { readonly kind: 'NS'; readonly host: string }
  | { readonly kind: 'raw'; readonly bytes: Uint8Array };

export interface DnsRecord {
  readonly name: string;
  readonly type: number;
  readonly cls: number;
  readonly ttl: number;
  readonly data: DnsRData;
}

export interface DnsMessage {
  readonly id: number;
  readonly flags: DnsFlags;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
  readonly additional: readonly DnsRecord[];
}

export function splitLabels(name: string): string[] {
  const n = name.endsWith('.') ? name.slice(0, -1) : name;
  return n === '' ? [] : n.split('.');
}

export function isValidLabel(l: string): boolean {
  return l.length >= 1 && l.length <= 63 && /^[A-Za-z0-9-]+$/.test(l);
}

/** Writes a domain name, compressing against suffixes already written (RFC 1035 §4.1.4). */
function writeName(w: ByteWriter, name: string, table: Map<string, number>): void {
  const labels = splitLabels(name);
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.').toLowerCase();
    const ptr = table.get(suffix);
    if (ptr !== undefined) {
      w.u16(0xc000 | ptr);
      return;
    }
    if (w.length < 0x4000) table.set(suffix, w.length);
    const label = labels[i] ?? '';
    if (!isValidLabel(label)) throw new Error(`invalid DNS label "${label}"`);
    w.u8(label.length).ascii(label);
  }
  w.u8(0);
}

function writeRecord(w: ByteWriter, rr: DnsRecord, table: Map<string, number>): void {
  writeName(w, rr.name, table);
  w.u16(rr.type).u16(rr.cls).u32(rr.ttl);
  const lenAt = w.length;
  w.u16(0);
  const start = w.length;
  switch (rr.data.kind) {
    case 'A':
      w.bytes(ipToBytes(rr.data.address));
      break;
    case 'NS':
      writeName(w, rr.data.host, table);
      break;
    case 'raw':
      w.bytes(rr.data.bytes);
      break;
  }
  w.patchU16(lenAt, w.length - start);
}

export function encodeDns(m: DnsMessage): Uint8Array {
  const w = new ByteWriter(128);
  const table = new Map<string, number>();
  w.u16(m.id)
    .u16(packDnsFlags(m.flags))
    .u16(m.questions.length)
    .u16(m.answers.length)
    .u16(m.authority.length)
    .u16(m.additional.length);
  for (const q of m.questions) {
    writeName(w, q.name, table);
    w.u16(q.type).u16(q.cls);
  }
  for (const rr of m.answers) writeRecord(w, rr, table);
  for (const rr of m.authority) writeRecord(w, rr, table);
  for (const rr of m.additional) writeRecord(w, rr, table);
  return w.finish();
}

interface ReadName {
  readonly name: string;
  readonly end: number;
  readonly parts: readonly NamePart[];
}

type NamePart =
  | { readonly kind: 'label'; readonly at: number; readonly text: string }
  | {
      readonly kind: 'pointer';
      readonly at: number;
      readonly target: number;
      readonly suffix: string;
    }
  | { readonly kind: 'root'; readonly at: number };

/** Reads a (possibly compressed) name starting at `at`. `base` is where the DNS message begins. */
function readName(buf: Uint8Array, base: number, end: number, at: number): ReadName {
  const labels: string[] = [];
  const parts: NamePart[] = [];
  let pos = at;
  let jumped = false;
  let afterFirstJump = -1;
  let hops = 0;
  for (;;) {
    if (pos >= end) throw new DecodeError('DNS name runs past the message');
    const len = buf[pos] ?? 0;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= end) throw new DecodeError('truncated DNS pointer');
      const target = ((len & 0x3f) << 8) | (buf[pos + 1] ?? 0);
      if (++hops > 16) throw new DecodeError('DNS compression loop');
      if (!jumped) {
        afterFirstJump = pos + 2;
        const suffix = readName(buf, base, end, base + target).name;
        parts.push({ kind: 'pointer', at: pos, target, suffix });
      }
      jumped = true;
      pos = base + target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new DecodeError('reserved DNS label type');
    if (len === 0) {
      if (!jumped) parts.push({ kind: 'root', at: pos });
      pos += 1;
      break;
    }
    if (pos + 1 + len > end) throw new DecodeError('DNS label runs past the message');
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode(buf[pos + 1 + i] ?? 0);
    if (!jumped) parts.push({ kind: 'label', at: pos, text });
    labels.push(text);
    pos += 1 + len;
  }
  return { name: labels.join('.'), end: jumped ? afterFirstJump : pos, parts };
}

const TYPE_NAMES: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 28: 'AAAA' };

export function typeName(t: number): string {
  return TYPE_NAMES[t] ?? `TYPE${t}`;
}

export interface DecodedDns {
  readonly message: DnsMessage;
  readonly layer: LayerNode;
}

function nameField(
  fc: FieldCollector,
  id: string,
  label: string,
  rn: ReadName,
  start: number,
): Field {
  const children: Field[] = [];
  rn.parts.forEach((p, i) => {
    if (p.kind === 'label') {
      children.push(
        fc.make(
          `${id}.label.${i}`,
          `Label ${i + 1}`,
          p.at,
          p.at + 1 + p.text.length,
          `${p.text.length} "${p.text}"`,
          'm.dns.label',
          { len: p.text.length, text: p.text },
          { key: 'field.dns.label', nameParams: { n: i + 1 } },
        ),
      );
    } else if (p.kind === 'pointer') {
      children.push(
        fc.make(
          `${id}.ptr`,
          'Compression pointer',
          p.at,
          p.at + 2,
          `0x${hex16(0xc000 | p.target)} → offset ${p.target}`,
          'm.dns.pointer',
          { offset: p.target, name: p.suffix },
        ),
      );
    } else {
      children.push(fc.make(`${id}.root`, 'End of name', p.at, p.at + 1, '0', 'm.dns.rootlabel'));
    }
  });
  return fc.make(
    id,
    label,
    start,
    rn.end,
    rn.name || '.',
    'm.dns.name',
    { name: rn.name || '.' },
    { children },
  );
}

export function decodeDns(buf: Uint8Array, start = 0, end = buf.length): DecodedDns {
  const r = new ByteReader(buf, start, end);
  const id = r.u16();
  const flagsRaw = r.u16();
  const qd = r.u16();
  const an = r.u16();
  const ns = r.u16();
  const ar = r.u16();
  const flags = unpackDnsFlags(flagsRaw);
  const fc = new FieldCollector(buf);
  const s = start;
  fc.add(
    'dns.id',
    'Transaction ID',
    s,
    s + 2,
    `0x${hex16(id)}`,
    flags.qr ? 'm.dns.id.r' : 'm.dns.id.q',
    {
      id: `0x${hex16(id)}`,
    },
  );
  const bits = [
    `QR=${flags.qr ? 1 : 0}`,
    `AA=${flags.aa ? 1 : 0}`,
    `RD=${flags.rd ? 1 : 0}`,
    `RA=${flags.ra ? 1 : 0}`,
    `RCODE=${flags.rcode}`,
  ].join(' · ');
  fc.add('dns.flags', 'Flags', s + 2, s + 4, `0x${hex16(flagsRaw)}`, flagsMeaning(flags), { bits });
  fc.add(
    'dns.counts',
    'Counts',
    s + 4,
    s + 12,
    `${qd} question · ${an} answer · ${ns} authority · ${ar} additional`,
    'm.dns.counts',
    {
      qd,
      an,
      ns,
      ar,
    },
    {
      children: [
        fc.make('dns.qdcount', 'Questions', s + 4, s + 6, String(qd), 'm.dns.qdcount', { n: qd }),
        fc.make('dns.ancount', 'Answers', s + 6, s + 8, String(an), 'm.dns.ancount', { n: an }),
        fc.make('dns.nscount', 'Authority records', s + 8, s + 10, String(ns), 'm.dns.nscount', {
          n: ns,
        }),
        fc.make('dns.arcount', 'Additional records', s + 10, s + 12, String(ar), 'm.dns.arcount', {
          n: ar,
        }),
      ],
    },
  );

  const questions: DnsQuestion[] = [];
  let pos = s + 12;
  for (let i = 0; i < qd; i++) {
    const rn = readName(buf, s, end, pos);
    fc.fields.push(nameField(fc, `dns.q.${i}.name`, 'Name', rn, pos));
    const qr = new ByteReader(buf, rn.end, end);
    const type = qr.u16();
    const cls = qr.u16();
    fc.add(
      `dns.q.${i}.type`,
      'Type',
      rn.end,
      rn.end + 2,
      `${type} (${typeName(type)})`,
      'm.dns.type',
      { type: typeName(type) },
    );
    fc.add(
      `dns.q.${i}.class`,
      'Class',
      rn.end + 2,
      rn.end + 4,
      cls === 1 ? '1 (IN)' : String(cls),
      'm.dns.class',
    );
    questions.push({ name: rn.name, type, cls });
    pos = rn.end + 4;
  }

  const sections: [string, number, DnsRecord[]][] = [
    ['an', an, []],
    ['ns', ns, []],
    ['ar', ar, []],
  ];
  for (const [sec, count, list] of sections) {
    for (let i = 0; i < count; i++) {
      const recStart = pos;
      const rn = readName(buf, s, end, pos);
      const rr = new ByteReader(buf, rn.end, end);
      const type = rr.u16();
      const cls = rr.u16();
      const ttl = rr.u32();
      const rdlen = rr.u16();
      const rdStart = rr.offset;
      if (rdStart + rdlen > end) throw new DecodeError('DNS RDATA runs past the message');
      let data: DnsRData;
      let rdField: Field;
      const id = `dns.${sec}.${i}`;
      if (type === DNS_TYPE_A && rdlen === 4) {
        const address = bytesToIp(buf, rdStart);
        data = { kind: 'A', address };
        rdField = fc.make(`${id}.addr`, 'Address', rdStart, rdStart + 4, address, 'm.dns.rdata.a', {
          address,
        });
      } else if (type === DNS_TYPE_NS) {
        const hn = readName(buf, s, end, rdStart);
        if (hn.end !== rdStart + rdlen) throw new DecodeError('NS RDATA length mismatch');
        data = { kind: 'NS', host: hn.name };
        rdField = nameField(fc, `${id}.ns`, 'Name server', hn, rdStart);
      } else {
        data = { kind: 'raw', bytes: buf.slice(rdStart, rdStart + rdlen) };
        rdField = fc.make(
          `${id}.raw`,
          'Data',
          rdStart,
          rdStart + rdlen,
          `${rdlen} bytes`,
          'm.dns.rdata.raw',
        );
      }
      const recEnd = rdStart + rdlen;
      const secName = sec === 'an' ? 'Answer' : sec === 'ns' ? 'Authority' : 'Additional';
      const children: Field[] = [
        nameField(fc, `${id}.name`, 'Name', rn, recStart),
        fc.make(
          `${id}.type`,
          'Type',
          rn.end,
          rn.end + 2,
          `${type} (${typeName(type)})`,
          'm.dns.type',
          { type: typeName(type) },
        ),
        fc.make(
          `${id}.class`,
          'Class',
          rn.end + 2,
          rn.end + 4,
          cls === 1 ? '1 (IN)' : String(cls),
          'm.dns.class',
        ),
        fc.make(`${id}.ttl`, 'TTL', rn.end + 4, rn.end + 8, `${ttl} s`, 'm.dns.ttl', {
          ttl,
          human: humanTtl(ttl),
        }),
        fc.make(
          `${id}.rdlen`,
          'Data length',
          rn.end + 8,
          rn.end + 10,
          `${rdlen} bytes`,
          'm.dns.rdlen',
          undefined,
          {
            expert: true,
          },
        ),
        rdField,
      ];
      const value =
        data.kind === 'A' ? data.address : data.kind === 'NS' ? data.host : `${rdlen} bytes`;
      fc.add(
        id,
        `${secName}: ${typeName(type)}`,
        recStart,
        recEnd,
        `${rn.name} → ${value}`,
        `m.dns.rr.${sec}`,
        { name: rn.name, type: typeName(type), value, ttl },
        { children, key: `field.dns.rr.${sec}`, nameParams: { type: typeName(type) } },
      );
      list.push({ name: rn.name, type, cls, ttl, data });
      pos = recEnd;
    }
  }
  if (pos !== end) throw new DecodeError(`${end - pos} trailing bytes after DNS message`);

  const q = questions[0];
  const message: DnsMessage = {
    id,
    flags,
    questions,
    answers: sections[0]?.[2] ?? [],
    authority: sections[1]?.[2] ?? [],
    additional: sections[2]?.[2] ?? [],
  };
  fc.fact('id', `0x${hex16(id)}`);
  if (q) fc.fact('question', `${typeName(q.type)} ${q.name}?`);
  const firstA = message.answers.find((a) => a.data.kind === 'A');
  if (firstA && firstA.data.kind === 'A')
    fc.fact('answer', `${firstA.data.address} · TTL ${firstA.ttl}`);
  const firstNs = message.authority.find((a) => a.data.kind === 'NS');
  if (!firstA && firstNs && firstNs.data.kind === 'NS') fc.fact('referral', firstNs.data.host);
  const summary = !flags.qr
    ? msg('s.dns.q', { name: q?.name ?? '?', type: typeName(q?.type ?? 1) })
    : firstA && firstA.data.kind === 'A'
      ? msg('s.dns.a', { name: firstA.name, address: firstA.data.address, ttl: firstA.ttl })
      : msg('s.dns.ref', { host: firstNs && firstNs.data.kind === 'NS' ? firstNs.data.host : '?' });
  return { message, layer: fc.layer('dns', 'DNS', 'application', s, end, summary) };
}

function flagsMeaning(f: DnsFlags): string {
  if (!f.qr) return f.rd ? 'm.dns.flags.q.rd' : 'm.dns.flags.q';
  if (f.aa) return 'm.dns.flags.r.aa';
  if (f.ra) return 'm.dns.flags.r.ra';
  return 'm.dns.flags.r';
}

export function humanTtl(ttl: number): string {
  if (ttl % 86400 === 0) return `${ttl / 86400} d`;
  if (ttl % 3600 === 0) return `${ttl / 3600} h`;
  if (ttl % 60 === 0) return `${ttl / 60} min`;
  return `${ttl} s`;
}
