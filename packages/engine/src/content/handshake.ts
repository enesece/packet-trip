import { concatBytes } from '../bytes/writer';
import type { Msg, ScenarioConfig } from '../model';
import type { Rng } from '../sim/rng';
import { msg } from '../proto/fields';
import { fakeCertificate, int, seq } from '../proto/der';
import {
  CT_APPDATA,
  CT_CCS,
  CT_HANDSHAKE,
  GROUP_X25519,
  SIG_ECDSA_P256_SHA256,
  SIG_RSA_PKCS1_SHA256,
  SIG_RSA_PSS_SHA256,
  certificate12,
  certificate13,
  certificateVerify,
  clientHello,
  clientKeyExchange,
  encryptedExtensions,
  ext,
  finished,
  serverHello,
  serverHelloDone,
  serverKeyExchange,
} from '../proto/tls';
import type { PlannedRecord, PlannedWrite } from './plan';
import type { SiteDef } from './sites';

/** Everything random or secret that the handshake messages depend on. */
export interface HandshakeMaterial {
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly clientPub: Uint8Array;
  readonly serverPub: Uint8Array;
  readonly certs: readonly Uint8Array[];
  readonly signature: Uint8Array;
  readonly serverFinished: Uint8Array;
  readonly clientFinished: Uint8Array;
}

export function baseMaterial(
  site: SiteDef,
  rng: Rng,
): Omit<HandshakeMaterial, 'clientPub' | 'serverPub' | 'serverFinished' | 'clientFinished'> {
  const r = rng.fork('handshake');
  const clientRandom = r.bytes(32);
  const serverRandom = r.bytes(32);
  const sessionId = r.bytes(32);
  const certRng = r.fork('certs');
  const certs = [
    fakeCertificate(
      {
        subject: site.host,
        issuer: 'Packet Trip Demo Issuing CA',
        san: [site.host, `www.${site.host}`],
        ca: false,
        padding: 520,
      },
      certRng,
    ),
    fakeCertificate(
      {
        subject: 'Packet Trip Demo Issuing CA',
        issuer: 'Packet Trip Demo Root',
        san: [],
        ca: true,
        padding: 380,
      },
      certRng,
    ),
  ];
  const signature = seq(int(r.bytes(32)), int(r.bytes(32)));
  return { clientRandom, serverRandom, sessionId, certs, signature };
}

export function simulatedMaterial(
  site: SiteDef,
  config: ScenarioConfig,
  rng: Rng,
): HandshakeMaterial {
  const base = baseMaterial(site, rng);
  const r = rng.fork('keys');
  const fin = config.tlsVersion === '1.3' ? 32 : 12;
  return {
    ...base,
    clientPub: r.bytes(32),
    serverPub: r.bytes(32),
    serverFinished: r.bytes(fin),
    clientFinished: r.bytes(fin),
  };
}

export interface Tls13Messages {
  readonly ch: Uint8Array;
  readonly sh: Uint8Array;
  readonly ee: Uint8Array;
  readonly cert: Uint8Array;
  readonly cv: Uint8Array;
  readonly sfin: Uint8Array;
  readonly cfin: Uint8Array;
}

export function tls13Messages(
  site: SiteDef,
  config: ScenarioConfig,
  m: HandshakeMaterial,
): Tls13Messages {
  const alpn = config.httpVersion === '2' ? ['h2', 'http/1.1'] : ['http/1.1'];
  const ch = clientHello({
    random: m.clientRandom,
    sessionId: m.sessionId,
    cipherSuites: [0x1301, 0x1302, 0x1303],
    extensions: [
      ext.serverName(site.host),
      ext.supportedVersionsClient([0x0304]),
      ext.supportedGroups([GROUP_X25519]),
      ext.keyShareClient(GROUP_X25519, m.clientPub),
      ext.signatureAlgorithms([SIG_ECDSA_P256_SHA256, SIG_RSA_PSS_SHA256, SIG_RSA_PKCS1_SHA256]),
      ext.alpn(alpn),
    ],
  });
  const sh = serverHello({
    random: m.serverRandom,
    sessionId: m.sessionId,
    cipherSuite: 0x1301,
    extensions: [ext.supportedVersionServer(0x0304), ext.keyShareServer(GROUP_X25519, m.serverPub)],
  });
  const ee = encryptedExtensions([
    ext.serverNameAck(),
    ext.alpn([config.httpVersion === '2' ? 'h2' : 'http/1.1']),
  ]);
  const cert = certificate13(m.certs);
  const cv = certificateVerify(SIG_ECDSA_P256_SHA256, m.signature);
  return {
    ch,
    sh,
    ee,
    cert,
    cv,
    sfin: finished(m.serverFinished),
    cfin: finished(m.clientFinished),
  };
}

const plain = (type: number, body: Uint8Array, label: string): PlannedRecord => ({
  outerType: type,
  encrypted: false,
  innerType: type,
  plaintext: body,
  label,
  http: null,
});

const enc13 = (body: Uint8Array, label: string): PlannedRecord => ({
  outerType: CT_APPDATA,
  encrypted: true,
  innerType: CT_HANDSHAKE,
  plaintext: body,
  label,
  http: null,
});

function write(
  side: 'client' | 'server',
  label: string,
  labelMsg: Msg,
  records: PlannedRecord[],
): PlannedWrite {
  return { side, label, labelMsg, records, resources: [], forRequest: -1 };
}

export function tls13Writes(msgs: Tls13Messages): PlannedWrite[] {
  return [
    write('client', 'ClientHello · key share', msg('w.ch13'), [
      plain(CT_HANDSHAKE, msgs.ch, 'ClientHello'),
    ]),
    write('server', 'ServerHello · cert · Finished', msg('w.sflight13'), [
      plain(CT_HANDSHAKE, msgs.sh, 'ServerHello'),
      enc13(msgs.ee, 'EncryptedExtensions'),
      enc13(msgs.cert, 'Certificate'),
      enc13(msgs.cv, 'CertificateVerify'),
      enc13(msgs.sfin, 'Finished'),
    ]),
    write('client', 'Finished', msg('w.cfin'), [enc13(msgs.cfin, 'Finished')]),
  ];
}

export interface Tls12Messages {
  readonly ch: Uint8Array;
  readonly sh: Uint8Array;
  readonly cert: Uint8Array;
  readonly ske: Uint8Array;
  readonly shd: Uint8Array;
  readonly cke: Uint8Array;
  readonly cfin: Uint8Array;
  readonly sfin: Uint8Array;
}

export function tls12Messages(
  site: SiteDef,
  config: ScenarioConfig,
  m: HandshakeMaterial,
): Tls12Messages {
  const alpn = config.httpVersion === '2' ? ['h2', 'http/1.1'] : ['http/1.1'];
  const ch = clientHello({
    random: m.clientRandom,
    sessionId: new Uint8Array(0),
    cipherSuites: [0xc02b, 0xc02c, 0xcca9],
    extensions: [
      ext.serverName(site.host),
      ext.supportedGroups([GROUP_X25519]),
      ext.ecPointFormats(),
      ext.signatureAlgorithms([SIG_ECDSA_P256_SHA256, SIG_RSA_PSS_SHA256, SIG_RSA_PKCS1_SHA256]),
      ext.alpn(alpn),
      ext.ems(),
    ],
  });
  const sh = serverHello({
    random: m.serverRandom,
    sessionId: m.sessionId,
    cipherSuite: 0xc02b,
    extensions: [ext.alpn([config.httpVersion === '2' ? 'h2' : 'http/1.1']), ext.ems()],
  });
  return {
    ch,
    sh,
    cert: certificate12(m.certs),
    ske: serverKeyExchange(GROUP_X25519, m.serverPub, SIG_ECDSA_P256_SHA256, m.signature),
    shd: serverHelloDone(),
    cke: clientKeyExchange(m.clientPub),
    cfin: finished(m.clientFinished),
    sfin: finished(m.serverFinished),
  };
}

const enc12 = (type: number, body: Uint8Array, label: string): PlannedRecord => ({
  outerType: type,
  encrypted: true,
  innerType: type,
  plaintext: body,
  label,
  http: null,
});

export function tls12Writes(m: Tls12Messages): PlannedWrite[] {
  const ccs = Uint8Array.of(1);
  return [
    write('client', 'ClientHello', msg('w.ch'), [plain(CT_HANDSHAKE, m.ch, 'ClientHello')]),
    write('server', 'ServerHello · cert · ServerHelloDone', msg('w.sflight12'), [
      plain(CT_HANDSHAKE, m.sh, 'ServerHello'),
      plain(CT_HANDSHAKE, m.cert, 'Certificate'),
      plain(CT_HANDSHAKE, m.ske, 'ServerKeyExchange'),
      plain(CT_HANDSHAKE, m.shd, 'ServerHelloDone'),
    ]),
    write('client', 'ClientKeyExchange · Finished', msg('w.cflight12'), [
      plain(CT_HANDSHAKE, m.cke, 'ClientKeyExchange'),
      plain(CT_CCS, ccs, 'ChangeCipherSpec'),
      enc12(CT_HANDSHAKE, m.cfin, 'Finished'),
    ]),
    write('server', 'ChangeCipherSpec · Finished', msg('w.sfin12'), [
      plain(CT_CCS, ccs, 'ChangeCipherSpec'),
      enc12(CT_HANDSHAKE, m.sfin, 'Finished'),
    ]),
  ];
}

export function concatWrites(ws: readonly { bytes: Uint8Array }[]): Uint8Array {
  return concatBytes(ws.map((w) => w.bytes));
}
