import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter, asciiBytes, bytesToAscii, concatBytes } from '../bytes/writer';
import { hex16, hexPreview, toHex } from '../bytes/hex';
import type { Field, LayerNode } from '../model';
import { parseCertSummary } from './der';
import { FieldCollector, msg } from './fields';

export const CT_CCS = 20;
export const CT_ALERT = 21;
export const CT_HANDSHAKE = 22;
export const CT_APPDATA = 23;

export const HS_CLIENT_HELLO = 1;
export const HS_SERVER_HELLO = 2;
export const HS_ENCRYPTED_EXTENSIONS = 8;
export const HS_CERTIFICATE = 11;
export const HS_SERVER_KEY_EXCHANGE = 12;
export const HS_SERVER_HELLO_DONE = 14;
export const HS_CERTIFICATE_VERIFY = 15;
export const HS_CLIENT_KEY_EXCHANGE = 16;
export const HS_FINISHED = 20;

export const EXT_SERVER_NAME = 0;
export const EXT_SUPPORTED_GROUPS = 10;
export const EXT_EC_POINT_FORMATS = 11;
export const EXT_SIGNATURE_ALGORITHMS = 13;
export const EXT_ALPN = 16;
export const EXT_EMS = 23;
export const EXT_SUPPORTED_VERSIONS = 43;
export const EXT_KEY_SHARE = 51;

export const GROUP_X25519 = 0x001d;
export const SIG_ECDSA_P256_SHA256 = 0x0403;
export const SIG_RSA_PSS_SHA256 = 0x0804;
export const SIG_RSA_PKCS1_SHA256 = 0x0401;

export const CONTENT_TYPE_NAMES: Record<number, string> = {
  20: 'change_cipher_spec',
  21: 'alert',
  22: 'handshake',
  23: 'application_data',
};

export const HANDSHAKE_NAMES: Record<number, string> = {
  1: 'ClientHello',
  2: 'ServerHello',
  4: 'NewSessionTicket',
  8: 'EncryptedExtensions',
  11: 'Certificate',
  12: 'ServerKeyExchange',
  14: 'ServerHelloDone',
  15: 'CertificateVerify',
  16: 'ClientKeyExchange',
  20: 'Finished',
};

export const CIPHER_NAMES: Record<number, string> = {
  0x1301: 'TLS_AES_128_GCM_SHA256',
  0x1302: 'TLS_AES_256_GCM_SHA384',
  0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
  0xc02b: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  0xc02c: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  0xcca9: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
};

const EXT_NAMES: Record<number, string> = {
  0: 'server_name',
  10: 'supported_groups',
  11: 'ec_point_formats',
  13: 'signature_algorithms',
  16: 'application_layer_protocol_negotiation',
  23: 'extended_master_secret',
  43: 'supported_versions',
  51: 'key_share',
};

const SIG_NAMES: Record<number, string> = {
  0x0403: 'ecdsa_secp256r1_sha256',
  0x0804: 'rsa_pss_rsae_sha256',
  0x0401: 'rsa_pkcs1_sha256',
};

const VERSION_NAMES: Record<number, string> = {
  0x0301: 'TLS 1.0',
  0x0303: 'TLS 1.2',
  0x0304: 'TLS 1.3',
};

export function encodeRecord(type: number, fragment: Uint8Array, version = 0x0303): Uint8Array {
  if (fragment.length > 16384 + 256) throw new Error('TLS record too large');
  return new ByteWriter(5 + fragment.length)
    .u8(type)
    .u16(version)
    .u16(fragment.length)
    .bytes(fragment)
    .finish();
}

export function handshake(type: number, body: Uint8Array): Uint8Array {
  return new ByteWriter(4 + body.length).u8(type).u24(body.length).bytes(body).finish();
}

export interface Extension {
  readonly type: number;
  readonly data: Uint8Array;
}

function encodeExtensions(exts: readonly Extension[]): Uint8Array {
  const w = new ByteWriter(256);
  w.u16(0);
  for (const e of exts) w.u16(e.type).u16(e.data.length).bytes(e.data);
  w.patchU16(0, w.length - 2);
  return w.finish();
}

const u16list = (vals: readonly number[], lenBytes: 1 | 2): Uint8Array => {
  const w = new ByteWriter(2 + vals.length * 2);
  if (lenBytes === 1) w.u8(vals.length * 2);
  else w.u16(vals.length * 2);
  for (const v of vals) w.u16(v);
  return w.finish();
};

export const ext = {
  serverName(host: string): Extension {
    const name = asciiBytes(host);
    const data = new ByteWriter()
      .u16(name.length + 3)
      .u8(0)
      .u16(name.length)
      .bytes(name)
      .finish();
    return { type: EXT_SERVER_NAME, data };
  },
  serverNameAck(): Extension {
    return { type: EXT_SERVER_NAME, data: new Uint8Array(0) };
  },
  supportedVersionsClient(versions: readonly number[]): Extension {
    return { type: EXT_SUPPORTED_VERSIONS, data: u16list(versions, 1) };
  },
  supportedVersionServer(v: number): Extension {
    return { type: EXT_SUPPORTED_VERSIONS, data: new ByteWriter(2).u16(v).finish() };
  },
  supportedGroups(groups: readonly number[]): Extension {
    return { type: EXT_SUPPORTED_GROUPS, data: u16list(groups, 2) };
  },
  keyShareClient(group: number, key: Uint8Array): Extension {
    const data = new ByteWriter()
      .u16(4 + key.length)
      .u16(group)
      .u16(key.length)
      .bytes(key)
      .finish();
    return { type: EXT_KEY_SHARE, data };
  },
  keyShareServer(group: number, key: Uint8Array): Extension {
    return {
      type: EXT_KEY_SHARE,
      data: new ByteWriter().u16(group).u16(key.length).bytes(key).finish(),
    };
  },
  signatureAlgorithms(algs: readonly number[]): Extension {
    return { type: EXT_SIGNATURE_ALGORITHMS, data: u16list(algs, 2) };
  },
  alpn(protocols: readonly string[]): Extension {
    const w = new ByteWriter().u16(0);
    for (const p of protocols) w.u8(p.length).ascii(p);
    w.patchU16(0, w.length - 2);
    return { type: EXT_ALPN, data: w.finish() };
  },
  ecPointFormats(): Extension {
    return { type: EXT_EC_POINT_FORMATS, data: Uint8Array.of(1, 0) };
  },
  ems(): Extension {
    return { type: EXT_EMS, data: new Uint8Array(0) };
  },
};

export interface ClientHelloSpec {
  readonly random: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly cipherSuites: readonly number[];
  readonly extensions: readonly Extension[];
}

export function clientHello(s: ClientHelloSpec): Uint8Array {
  const body = new ByteWriter(512)
    .u16(0x0303)
    .bytes(s.random)
    .u8(s.sessionId.length)
    .bytes(s.sessionId)
    .bytes(u16list(s.cipherSuites, 2))
    .u8(1)
    .u8(0)
    .bytes(encodeExtensions(s.extensions))
    .finish();
  return handshake(HS_CLIENT_HELLO, body);
}

export interface ServerHelloSpec {
  readonly random: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly cipherSuite: number;
  readonly extensions: readonly Extension[];
}

export function serverHello(s: ServerHelloSpec): Uint8Array {
  const body = new ByteWriter(256)
    .u16(0x0303)
    .bytes(s.random)
    .u8(s.sessionId.length)
    .bytes(s.sessionId)
    .u16(s.cipherSuite)
    .u8(0)
    .bytes(encodeExtensions(s.extensions))
    .finish();
  return handshake(HS_SERVER_HELLO, body);
}

export function encryptedExtensions(exts: readonly Extension[]): Uint8Array {
  return handshake(HS_ENCRYPTED_EXTENSIONS, encodeExtensions(exts));
}

export function certificate13(certs: readonly Uint8Array[]): Uint8Array {
  const list = new ByteWriter(4096);
  for (const c of certs) list.u24(c.length).bytes(c).u16(0);
  const l = list.finish();
  return handshake(
    HS_CERTIFICATE,
    new ByteWriter(l.length + 4).u8(0).u24(l.length).bytes(l).finish(),
  );
}

export function certificate12(certs: readonly Uint8Array[]): Uint8Array {
  const list = new ByteWriter(4096);
  for (const c of certs) list.u24(c.length).bytes(c);
  const l = list.finish();
  return handshake(HS_CERTIFICATE, new ByteWriter(l.length + 3).u24(l.length).bytes(l).finish());
}

export function certificateVerify(alg: number, sig: Uint8Array): Uint8Array {
  return handshake(
    HS_CERTIFICATE_VERIFY,
    new ByteWriter().u16(alg).u16(sig.length).bytes(sig).finish(),
  );
}

export function finished(verifyData: Uint8Array): Uint8Array {
  return handshake(HS_FINISHED, verifyData);
}

export function serverKeyExchange(
  group: number,
  pub: Uint8Array,
  alg: number,
  sig: Uint8Array,
): Uint8Array {
  return handshake(
    HS_SERVER_KEY_EXCHANGE,
    new ByteWriter()
      .u8(3)
      .u16(group)
      .u8(pub.length)
      .bytes(pub)
      .u16(alg)
      .u16(sig.length)
      .bytes(sig)
      .finish(),
  );
}

export function serverHelloDone(): Uint8Array {
  return handshake(HS_SERVER_HELLO_DONE, new Uint8Array(0));
}

export function clientKeyExchange(pub: Uint8Array): Uint8Array {
  return handshake(HS_CLIENT_KEY_EXCHANGE, new ByteWriter().u8(pub.length).bytes(pub).finish());
}

/* ------------------------------------------------------------------------------------------ */
/* Display decoding                                                                            */
/* ------------------------------------------------------------------------------------------ */

function decodeExtensionFields(
  fc: FieldCollector,
  b: Uint8Array,
  at: number,
  end: number,
  idp: string,
): Field[] {
  const out: Field[] = [];
  const r = new ByteReader(b, at, end);
  let i = 0;
  while (r.remaining > 0) {
    const s = r.offset;
    const type = r.u16();
    const len = r.u16();
    const ds = r.offset;
    r.bytes(len);
    const name = EXT_NAMES[type] ?? `extension ${type}`;
    const kids: Field[] = [
      fc.make(
        `${idp}.${i}.type`,
        'Type',
        s,
        s + 2,
        `${type} (${name})`,
        'm.tls.ext.type',
        { name },
        { expert: true },
      ),
      fc.make(
        `${idp}.${i}.len`,
        'Length',
        s + 2,
        s + 4,
        `${len} bytes`,
        'm.tls.len',
        { len },
        { expert: true },
      ),
    ];
    let display = name;
    let key = `m.tls.ext.${type}`;
    const params: Record<string, string | number> = {};
    const dr = new ByteReader(b, ds, ds + len);
    if (type === EXT_SERVER_NAME && len > 0) {
      dr.u16();
      dr.u8();
      const n = dr.u16();
      const host = bytesToAscii(dr.bytes(n));
      display = `server_name = ${host}`;
      params.host = host;
      kids.push(
        fc.make(`${idp}.${i}.sni`, 'Host name', ds + 5, ds + 5 + n, host, 'm.tls.sni', { host }),
      );
    } else if (type === EXT_SERVER_NAME) {
      key = 'm.tls.ext.0.ack';
    } else if (type === EXT_SUPPORTED_VERSIONS) {
      const vals: string[] = [];
      if (len === 2) vals.push(VERSION_NAMES[dr.u16()] ?? '?');
      else {
        const n = dr.u8();
        for (let k = 0; k < n / 2; k++) {
          const v = dr.u16();
          vals.push(`0x${hex16(v)} (${VERSION_NAMES[v] ?? '?'})`);
        }
      }
      display = `supported_versions = ${vals.join(', ')}`;
      params.versions = vals.join(', ');
    } else if (type === EXT_SUPPORTED_GROUPS) {
      const n = dr.u16();
      const g: string[] = [];
      for (let k = 0; k < n / 2; k++) g.push(dr.u16() === GROUP_X25519 ? 'x25519' : '?');
      display = `supported_groups = ${g.join(', ')}`;
    } else if (type === EXT_KEY_SHARE) {
      let group: number;
      let klen: number;
      if (len >= 2 && dr.remaining >= 2 && b.length >= ds + 2) {
        // Client form has a 2-byte list length first; server form does not.
        const first = dr.u16();
        if (first === len - 2) {
          group = dr.u16();
        } else {
          group = first;
        }
        klen = dr.u16();
        const ks = dr.offset;
        kids.push(
          fc.make(
            `${idp}.${i}.key`,
            'Public key',
            ks,
            ks + klen,
            hexPreview(b, ks, ks + klen, 8),
            'm.tls.keyshare.key',
            { n: klen },
          ),
        );
        display = `key_share = ${group === GROUP_X25519 ? 'x25519' : group} · ${klen} B`;
      }
    } else if (type === EXT_SIGNATURE_ALGORITHMS) {
      const n = dr.u16();
      const a: string[] = [];
      for (let k = 0; k < n / 2; k++) a.push(SIG_NAMES[dr.u16()] ?? '?');
      display = `signature_algorithms = ${a.join(', ')}`;
    } else if (type === EXT_ALPN) {
      dr.u16();
      const p: string[] = [];
      while (dr.remaining > 0) p.push(bytesToAscii(dr.bytes(dr.u8())));
      display = `ALPN = ${p.join(', ')}`;
      params.protocols = p.join(', ');
    }
    out.push(
      fc.make(`${idp}.${i}`, name, s, ds + len, display, key, params, {
        children: kids,
        key: 'field.tls.ext',
        nameParams: { name },
      }),
    );
    i++;
  }
  return out;
}

export interface HandshakeDecode {
  readonly layer: LayerNode;
  readonly type: number;
}

/** Decodes one or more complete handshake messages for the inspector. */
export function decodeHandshakes(
  b: Uint8Array,
  start: number,
  end: number,
  idBase: string,
  tls12: boolean,
): HandshakeDecode[] {
  const out: HandshakeDecode[] = [];
  let pos = start;
  let n = 0;
  while (pos < end) {
    const r = new ByteReader(b, pos, end);
    const type = r.u8();
    const len = r.u24();
    if (pos + 4 + len > end) throw new DecodeError('handshake message runs past its record');
    const name = HANDSHAKE_NAMES[type] ?? `handshake ${type}`;
    const fc = new FieldCollector(b);
    const idp = `${idBase}.hs${n}`;
    fc.add(`${idp}.type`, 'Handshake type', pos, pos + 1, `${type} (${name})`, `m.tls.hs.${type}`);
    fc.add(
      `${idp}.len`,
      'Length',
      pos + 1,
      pos + 4,
      `${len} bytes`,
      'm.tls.len',
      { len },
      { expert: true },
    );
    const bs = pos + 4;
    const be = bs + len;
    const br = new ByteReader(b, bs, be);
    const p: Record<string, string | number> = {};
    if (type === HS_CLIENT_HELLO || type === HS_SERVER_HELLO) {
      const v = br.u16();
      fc.add(
        `${idp}.ver`,
        'Legacy version',
        bs,
        bs + 2,
        `0x${hex16(v)} (${VERSION_NAMES[v] ?? '?'})`,
        'm.tls.legacyver',
        undefined,
        {
          expert: true,
        },
      );
      br.bytes(32);
      fc.add(
        `${idp}.random`,
        'Random',
        bs + 2,
        bs + 34,
        hexPreview(b, bs + 2, bs + 34, 8),
        'm.tls.random',
      );
      const sl = br.u8();
      br.bytes(sl);
      fc.add(
        `${idp}.sid`,
        'Session ID',
        bs + 34,
        bs + 35 + sl,
        `${sl} bytes`,
        'm.tls.sid',
        { n: sl },
        { expert: true },
      );
      if (type === HS_CLIENT_HELLO) {
        const cs = br.offset;
        const cl = br.u16();
        const suites: Field[] = [];
        for (let k = 0; k < cl / 2; k++) {
          const at = br.offset;
          const c = br.u16();
          suites.push(
            fc.make(
              `${idp}.cs.${k}`,
              `Suite ${k + 1}`,
              at,
              at + 2,
              CIPHER_NAMES[c] ?? `0x${hex16(c)}`,
              'm.tls.suite',
              undefined,
              { key: 'field.tls.suite.n', nameParams: { n: k + 1 } },
            ),
          );
        }
        fc.add(
          `${idp}.suites`,
          'Cipher suites',
          cs,
          cs + 2 + cl,
          `${cl / 2} suites`,
          'm.tls.suites',
          { n: cl / 2 },
          { children: suites },
        );
        const cm = br.offset;
        const cml = br.u8();
        br.bytes(cml);
        fc.add(
          `${idp}.comps`,
          'Compression methods',
          cm,
          cm + 1 + cml,
          'null',
          'm.tls.comp',
          undefined,
          { expert: true },
        );
        p.suites = cl / 2;
      } else {
        const at = br.offset;
        const c = br.u16();
        fc.add(
          `${idp}.suite`,
          'Cipher suite',
          at,
          at + 2,
          CIPHER_NAMES[c] ?? `0x${hex16(c)}`,
          'm.tls.suite.chosen',
          {
            suite: CIPHER_NAMES[c] ?? '?',
          },
        );
        br.u8();
        fc.add(`${idp}.comp`, 'Compression', at + 2, at + 3, 'null', 'm.tls.comp', undefined, {
          expert: true,
        });
        p.suite = CIPHER_NAMES[c] ?? '?';
      }
      if (br.remaining > 0) {
        const es = br.offset;
        const el = br.u16();
        const kids = decodeExtensionFields(fc, b, es + 2, es + 2 + el, `${idp}.ext`);
        fc.add(
          `${idp}.exts`,
          'Extensions',
          es,
          es + 2 + el,
          `${kids.length} extensions`,
          'm.tls.exts',
          { n: kids.length },
          { children: kids },
        );
        const sni = kids.find((k) => k.display.startsWith('server_name ='));
        if (sni) fc.fact('SNI', sni.display.replace('server_name = ', ''));
        const ks = kids.find((k) => k.display.startsWith('key_share'));
        if (ks) fc.fact('key share', ks.display.replace('key_share = ', ''));
      }
    } else if (type === HS_ENCRYPTED_EXTENSIONS) {
      const el = br.u16();
      const kids = decodeExtensionFields(fc, b, bs + 2, bs + 2 + el, `${idp}.ext`);
      fc.add(
        `${idp}.exts`,
        'Extensions',
        bs,
        bs + 2 + el,
        `${kids.length} extensions`,
        'm.tls.exts',
        { n: kids.length },
        { children: kids },
      );
    } else if (type === HS_CERTIFICATE) {
      let lpos = bs;
      if (!tls12) {
        const cl = br.u8();
        br.bytes(cl);
        fc.add(
          `${idp}.ctx`,
          'Request context',
          bs,
          bs + 1 + cl,
          'empty',
          'm.tls.certctx',
          undefined,
          { expert: true },
        );
        lpos = bs + 1 + cl;
      }
      const listLen = br.u24();
      const certs: Field[] = [];
      let k = 0;
      while (br.offset < lpos + 3 + listLen) {
        const at = br.offset;
        const clen = br.u24();
        const der = br.bytes(clen);
        let summary;
        try {
          summary = parseCertSummary(der);
        } catch {
          summary = { subject: '?', issuer: '?', notBefore: '?', notAfter: '?' };
        }
        let endAt = at + 3 + clen;
        if (!tls12) {
          const xl = br.u16();
          br.bytes(xl);
          endAt += 2 + xl;
        }
        certs.push(
          fc.make(
            `${idp}.cert.${k}`,
            k === 0 ? 'Leaf certificate' : 'Intermediate certificate',
            at,
            endAt,
            `CN=${summary.subject} · issued by ${summary.issuer} · ${clen} B`,
            'm.tls.cert',
            {
              subject: summary.subject,
              issuer: summary.issuer,
              from: summary.notBefore,
              to: summary.notAfter,
              n: clen,
            },
            { key: k === 0 ? 'field.tls.cert.leaf' : 'field.tls.cert.intermediate' },
          ),
        );
        if (k === 0) fc.fact('subject', summary.subject);
        k++;
      }
      fc.add(
        `${idp}.certs`,
        'Certificate chain',
        lpos,
        lpos + 3 + listLen,
        `${certs.length} certificates`,
        'm.tls.chain',
        { n: certs.length },
        {
          children: certs,
        },
      );
      p.n = certs.length;
    } else if (type === HS_CERTIFICATE_VERIFY) {
      const alg = br.u16();
      const sl = br.u16();
      fc.add(
        `${idp}.alg`,
        'Signature algorithm',
        bs,
        bs + 2,
        SIG_NAMES[alg] ?? `0x${hex16(alg)}`,
        'm.tls.cv.alg',
      );
      fc.add(
        `${idp}.sig`,
        'Signature',
        bs + 2,
        bs + 4 + sl,
        hexPreview(b, bs + 4, bs + 4 + sl, 8),
        'm.tls.cv.sig',
        { n: sl },
      );
    } else if (type === HS_FINISHED) {
      fc.add(`${idp}.vd`, 'Verify data', bs, be, hexPreview(b, bs, be, 8), 'm.tls.finished', {
        n: len,
      });
    } else if (type === HS_SERVER_KEY_EXCHANGE) {
      br.u8();
      br.u16();
      const pl = br.u8();
      fc.add(`${idp}.curve`, 'Curve', bs, bs + 3, 'named_curve x25519', 'm.tls.ske.curve');
      fc.add(
        `${idp}.spub`,
        'Server public key',
        bs + 3,
        bs + 4 + pl,
        hexPreview(b, bs + 4, bs + 4 + pl, 8),
        'm.tls.ske.pub',
        { n: pl },
      );
      br.bytes(pl);
      const alg = br.u16();
      const sl = br.u16();
      const ss = bs + 4 + pl;
      fc.add(
        `${idp}.sig`,
        'Signature',
        ss,
        ss + 4 + sl,
        `${SIG_NAMES[alg] ?? '?'} · ${sl} B`,
        'm.tls.ske.sig',
      );
    } else if (type === HS_SERVER_HELLO_DONE) {
      fc.add(`${idp}.empty`, 'Body', bs, be, 'empty', 'm.tls.shd');
    } else if (type === HS_CLIENT_KEY_EXCHANGE) {
      const pl = br.u8();
      fc.add(
        `${idp}.cpub`,
        'Client public key',
        bs,
        bs + 1 + pl,
        hexPreview(b, bs + 1, bs + 1 + pl, 8),
        'm.tls.cke.pub',
        { n: pl },
      );
    }
    out.push({
      type,
      layer: fc.layer(idp, name, 'security', pos, be, msg(`s.tls.hs.${type}`, p)),
    });
    pos = be;
    n++;
  }
  return out;
}

export function versionName(v: number): string {
  return VERSION_NAMES[v] ?? `0x${hex16(v)}`;
}

export function previewHex(b: Uint8Array, s: number, e: number): string {
  return hexPreview(b, s, e, 8);
}

export function recordHeaderFields(
  fc: FieldCollector,
  b: Uint8Array,
  at: number,
  idp: string,
  encrypted: boolean,
): { type: number; version: number; length: number } {
  const type = b[at] ?? 0;
  const version = ((b[at + 1] ?? 0) << 8) | (b[at + 2] ?? 0);
  const length = ((b[at + 3] ?? 0) << 8) | (b[at + 4] ?? 0);
  const tn = CONTENT_TYPE_NAMES[type] ?? String(type);
  fc.add(
    `${idp}.ct`,
    'Content type',
    at,
    at + 1,
    `${type} (${tn})`,
    encrypted && type === CT_APPDATA ? 'm.tls.ct.disguised' : `m.tls.ct.${type}`,
  );
  fc.add(
    `${idp}.ver`,
    'Legacy version',
    at + 1,
    at + 3,
    `0x${hex16(version)} (${versionName(version)})`,
    'm.tls.recver',
    undefined,
    {
      expert: true,
    },
  );
  fc.add(`${idp}.len`, 'Length', at + 3, at + 5, `${length} bytes`, 'm.tls.reclen', {
    len: length,
  });
  return { type, version, length };
}

export { toHex, concatBytes };
