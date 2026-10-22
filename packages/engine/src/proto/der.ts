import { asciiBytes, bytesToAscii, concatBytes } from '../bytes/writer';
import type { Rng } from '../sim/rng';

/** Minimal DER (X.690) builder and walker — enough to make and read a plausible fake certificate. */

function lenBytes(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  return Uint8Array.of(0x82, n >> 8, n & 0xff);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), lenBytes(content.length), content]);
}

export const seq = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, concatBytes(parts));
export const set = (...parts: Uint8Array[]): Uint8Array => tlv(0x31, concatBytes(parts));
export const int = (b: Uint8Array): Uint8Array =>
  tlv(0x02, (b[0] ?? 0) & 0x80 ? concatBytes([Uint8Array.of(0), b]) : b);
export const utf8 = (s: string): Uint8Array => tlv(0x0c, asciiBytes(s));
export const printable = (s: string): Uint8Array => tlv(0x13, asciiBytes(s));
export const utcTime = (s: string): Uint8Array => tlv(0x17, asciiBytes(s));
export const bitString = (b: Uint8Array): Uint8Array =>
  tlv(0x03, concatBytes([Uint8Array.of(0), b]));
export const octets = (b: Uint8Array): Uint8Array => tlv(0x04, b);
export const explicit = (n: number, inner: Uint8Array): Uint8Array => tlv(0xa0 | n, inner);
export const bool = (v: boolean): Uint8Array => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
}

const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_C = '2.5.4.6';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_EC_PUBKEY = '1.2.840.10045.2.1';
const OID_P256 = '1.2.840.10045.3.1.7';
const OID_SAN = '2.5.29.17';
const OID_BASIC = '2.5.29.19';
const OID_SCT = '1.3.6.1.4.1.11129.2.4.2';

function name(cn: string, o: string): Uint8Array {
  return seq(
    set(seq(oid(OID_C), printable('ZZ'))),
    set(seq(oid(OID_O), utf8(o))),
    set(seq(oid(OID_CN), utf8(cn))),
  );
}

export interface FakeCertSpec {
  readonly subject: string;
  readonly issuer: string;
  readonly san: readonly string[];
  readonly ca: boolean;
  /** Extra opaque extension bytes so the certificate reaches a realistic size. */
  readonly padding: number;
}

/** A structurally valid X.509 certificate whose key and signature are random bytes. */
export function fakeCertificate(spec: FakeCertSpec, rng: Rng): Uint8Array {
  const alg = seq(oid(OID_ECDSA_SHA256));
  const spki = seq(
    seq(oid(OID_EC_PUBKEY), oid(OID_P256)),
    bitString(concatBytes([Uint8Array.of(4), rng.bytes(64)])),
  );
  const exts: Uint8Array[] = [
    seq(oid(OID_BASIC), bool(true), octets(seq(...(spec.ca ? [bool(true)] : [])))),
  ];
  if (spec.san.length > 0) {
    exts.push(seq(oid(OID_SAN), octets(seq(...spec.san.map((d) => tlv(0x82, asciiBytes(d)))))));
  }
  if (spec.padding > 0) exts.push(seq(oid(OID_SCT), octets(octets(rng.bytes(spec.padding)))));
  const tbs = seq(
    explicit(0, int(Uint8Array.of(2))),
    int(rng.bytes(16)),
    alg,
    name(spec.issuer, 'Packet Trip Demo'),
    seq(utcTime('260901000000Z'), utcTime('261130235959Z')),
    name(spec.subject, 'Packet Trip Demo'),
    spki,
    explicit(3, seq(...exts)),
  );
  const sig = seq(int(rng.bytes(32)), int(rng.bytes(32)));
  return seq(tbs, alg, bitString(sig));
}

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function readTlv(b: Uint8Array, at: number): Tlv {
  const tag = b[at] ?? 0;
  let len = b[at + 1] ?? 0;
  let cs = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (b[at + 2 + i] ?? 0);
    cs = at + 2 + n;
  }
  return { tag, start: at, contentStart: cs, end: cs + len };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.contentStart;
  while (p < t.end) {
    const c = readTlv(b, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function readCn(b: Uint8Array, nameTlv: Tlv): string {
  for (const rdn of children(b, nameTlv)) {
    for (const atv of children(b, rdn)) {
      const [o, v] = children(b, atv);
      if (!o || !v) continue;
      if (bytesToAscii(b.subarray(o.start, o.end)) === bytesToAscii(oid(OID_CN))) {
        return bytesToAscii(b.subarray(v.contentStart, v.end));
      }
    }
  }
  return '?';
}

export interface CertSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

/** Reads subject/issuer/validity back out of DER bytes. */
export function parseCertSummary(der: Uint8Array): CertSummary {
  const cert = readTlv(der, 0);
  const [tbs] = children(der, cert);
  if (!tbs) throw new Error('bad certificate');
  const f = children(der, tbs);
  const off = f[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = f[2 + off];
  const validity = f[3 + off];
  const subject = f[4 + off];
  if (!issuer || !validity || !subject) throw new Error('bad tbsCertificate');
  const [nb, na] = children(der, validity);
  const t = (x: Tlv | undefined): string =>
    x ? bytesToAscii(der.subarray(x.contentStart, x.end)) : '?';
  const fmt = (s: string): string =>
    s.length >= 6 ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : s;
  return {
    subject: readCn(der, subject),
    issuer: readCn(der, issuer),
    notBefore: fmt(t(nb)),
    notAfter: fmt(t(na)),
  };
}
