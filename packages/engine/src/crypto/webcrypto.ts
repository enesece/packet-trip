import type { Msg, ScenarioConfig } from '../model';
import type { CryptoMaterial, KeyScheduleStep, SealedConnection, TrafficKey } from './types';
import { buildOrigin, buildSimulatedMaterial } from './simulated';
import { Sealer, sealWriteAsync, type RecordCipherInput } from './seal';
import { createRng } from '../sim/rng';
import type { Simulation } from '../sim/simulator';
import { getSite } from '../content/sites';
import { planApp } from '../content/plan';
import {
  baseMaterial,
  tls13Messages,
  tls13Writes,
  type HandshakeMaterial,
} from '../content/handshake';
import { ByteWriter, asciiBytes, bytesEqual, concatBytes } from '../bytes/writer';
import { toHex } from '../bytes/hex';
import { msg } from '../proto/fields';

/**
 * Phase 2: a real TLS 1.3 key schedule (RFC 8446 §7) using the Web Crypto API. The engine stays
 * DOM-free: only the standard `crypto.subtle` interface is used, typed minimally here so the
 * engine compiles without DOM typings. Works in browsers, workers and Node ≥ 20.
 */

type Bytes = Uint8Array;
type Key = object;

interface SubtleLike {
  importKey(
    format: string,
    keyData: unknown,
    algorithm: unknown,
    extractable: boolean,
    usages: string[],
  ): Promise<Key>;
  exportKey(format: 'jwk', key: Key): Promise<{ x?: string }>;
  deriveBits(algorithm: unknown, baseKey: Key, length: number): Promise<ArrayBuffer>;
  sign(algorithm: unknown, key: Key, data: Bytes): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Bytes): Promise<ArrayBuffer>;
  encrypt(algorithm: unknown, key: Key, data: Bytes): Promise<ArrayBuffer>;
  decrypt(algorithm: unknown, key: Key, data: Bytes): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike | null {
  const c = (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto;
  return c?.subtle ?? null;
}

const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function b64urlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = (globalThis as unknown as { atob: (s: string) => string }).atob(
    b64 + '==='.slice((b64.length + 3) % 4),
  );
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** True when this runtime can do X25519 in Web Crypto. */
export async function webCryptoAvailable(): Promise<boolean> {
  const s = subtle();
  if (!s) return false;
  try {
    await x25519Private(s, new Uint8Array(32).fill(7));
    return true;
  } catch {
    return false;
  }
}

async function x25519Private(s: SubtleLike, priv: Bytes): Promise<{ key: Key; pub: Bytes }> {
  const key = await s.importKey(
    'pkcs8',
    concatBytes([PKCS8_X25519_PREFIX, priv]),
    { name: 'X25519' },
    true,
    ['deriveBits'],
  );
  const jwk = await s.exportKey('jwk', key);
  if (!jwk.x) throw new Error('no public key in JWK');
  return { key, pub: b64urlDecode(jwk.x) };
}

async function x25519Shared(s: SubtleLike, priv: Key, peerPub: Bytes): Promise<Bytes> {
  const pub = await s.importKey('raw', peerPub, { name: 'X25519' }, true, []);
  return new Uint8Array(await s.deriveBits({ name: 'X25519', public: pub }, priv, 256));
}

export class Hkdf {
  constructor(private readonly s: SubtleLike) {}

  async hash(data: Bytes): Promise<Bytes> {
    return new Uint8Array(await this.s.digest('SHA-256', data));
  }

  async hmac(key: Bytes, data: Bytes): Promise<Bytes> {
    const k = await this.s.importKey(
      'raw',
      key.length ? key : new Uint8Array(32),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(await this.s.sign('HMAC', k, data));
  }

  /** HKDF-Extract(salt, IKM) = HMAC-Hash(salt, IKM) */
  extract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
    return this.hmac(salt, ikm);
  }

  async expand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
    const out: Bytes[] = [];
    let prev: Bytes = new Uint8Array(0);
    let n = 0;
    for (let i = 1; n < length; i++) {
      prev = await this.hmac(prk, concatBytes([prev, info, Uint8Array.of(i)]));
      out.push(prev);
      n += prev.length;
    }
    return concatBytes(out).slice(0, length);
  }

  /** HKDF-Expand-Label(Secret, Label, Context, Length) from RFC 8446 §7.1 */
  expandLabel(secret: Bytes, label: string, context: Bytes, length: number): Promise<Bytes> {
    const full = asciiBytes(`tls13 ${label}`);
    const info = new ByteWriter()
      .u16(length)
      .u8(full.length)
      .bytes(full)
      .u8(context.length)
      .bytes(context)
      .finish();
    return this.expand(secret, info, length);
  }

  async deriveSecret(secret: Bytes, label: string, messages: Bytes): Promise<Bytes> {
    return this.expandLabel(secret, label, await this.hash(messages), 32);
  }
}

export function nonceFor(iv: Bytes, seq: number): Bytes {
  const n = iv.slice();
  for (let i = 0; i < 8; i++) {
    const shift = 8 * i;
    const b = shift < 32 ? (seq >>> shift) & 0xff : Math.floor(seq / 2 ** shift) & 0xff;
    const idx = n.length - 1 - i;
    n[idx] = (n[idx] ?? 0) ^ b;
  }
  return n;
}

const hex = (b: Bytes): string => toHex(b, 0, b.length, '');

/** Builds all TLS bytes for the run with real keys. Falls back to simulated crypto if needed. */
export async function buildWebCryptoMaterial(config: ScenarioConfig): Promise<CryptoMaterial> {
  const rng = createRng(config.seed).fork('crypto');
  const s = subtle();
  if (config.tlsVersion !== '1.3') return buildSimulatedMaterial(config, rng, 'tls12-simulated');
  if (!s || !(await webCryptoAvailable()))
    return buildSimulatedMaterial(config, rng, 'x25519-unavailable');

  const site = getSite(config.site, config.inlineCriticalCss);
  const viaCdn = config.cdn && site.cdn;
  const app = planApp(site, config, viaCdn, rng.fork('app'));
  const base = baseMaterial(site, rng);
  const keyRng = rng.fork('x25519');
  const client = await x25519Private(s, keyRng.bytes(32));
  const server = await x25519Private(s, keyRng.bytes(32));
  const h = new Hkdf(s);
  const zeros = new Uint8Array(32);
  const steps: KeyScheduleStep[] = [];
  const step = (id: string, name: string, formula: string, value: Bytes, explain: Msg): Bytes => {
    steps.push({ id, name, formula, value: hex(value), explain });
    return value;
  };

  // Messages up to CertificateVerify do not depend on the Finished values.
  const draft: HandshakeMaterial = {
    ...base,
    clientPub: client.pub,
    serverPub: server.pub,
    serverFinished: zeros,
    clientFinished: zeros,
  };
  const m0 = tls13Messages(site, config, draft);

  step(
    'client-pub',
    'Client key share',
    'X25519(client_private, 9)',
    client.pub,
    msg('keys.clientPub'),
  );
  step(
    'server-pub',
    'Server key share',
    'X25519(server_private, 9)',
    server.pub,
    msg('keys.serverPub'),
  );
  const shared = step(
    'shared',
    'Shared secret',
    'X25519(client_private, server_public)',
    await x25519Shared(s, client.key, server.pub),
    msg('keys.shared'),
  );
  const serverView = await x25519Shared(s, server.key, client.pub);
  if (!bytesEqual(shared, serverView)) throw new Error('X25519 disagreement');

  const early = step(
    'early',
    'Early secret',
    'HKDF-Extract(0, 0)',
    await h.extract(zeros, zeros),
    msg('keys.early'),
  );
  const derived1 = step(
    'derived1',
    'Derived',
    'Derive-Secret(early, "derived", "")',
    await h.deriveSecret(early, 'derived', new Uint8Array(0)),
    msg('keys.derived'),
  );
  const hs = step(
    'hs',
    'Handshake secret',
    'HKDF-Extract(derived, shared)',
    await h.extract(derived1, shared),
    msg('keys.hs'),
  );
  const thSh = step(
    'th-sh',
    'Transcript hash',
    'SHA-256(ClientHello ‖ ServerHello)',
    await h.hash(concatBytes([m0.ch, m0.sh])),
    msg('keys.thSh'),
  );
  const cHs = step(
    'c-hs',
    'Client handshake traffic secret',
    'HKDF-Expand-Label(hs, "c hs traffic", th, 32)',
    await h.expandLabel(hs, 'c hs traffic', thSh, 32),
    msg('keys.cHs'),
  );
  const sHs = step(
    's-hs',
    'Server handshake traffic secret',
    'HKDF-Expand-Label(hs, "s hs traffic", th, 32)',
    await h.expandLabel(hs, 's hs traffic', thSh, 32),
    msg('keys.sHs'),
  );
  const sHsKey = step(
    's-hs-key',
    'Server handshake key',
    'HKDF-Expand-Label(s_hs, "key", "", 16)',
    await h.expandLabel(sHs, 'key', new Uint8Array(0), 16),
    msg('keys.key'),
  );
  const sHsIv = step(
    's-hs-iv',
    'Server handshake IV',
    'HKDF-Expand-Label(s_hs, "iv", "", 12)',
    await h.expandLabel(sHs, 'iv', new Uint8Array(0), 12),
    msg('keys.iv'),
  );
  const cHsKey = await h.expandLabel(cHs, 'key', new Uint8Array(0), 16);
  const cHsIv = await h.expandLabel(cHs, 'iv', new Uint8Array(0), 12);

  const sFinKey = await h.expandLabel(sHs, 'finished', new Uint8Array(0), 32);
  const thCv = await h.hash(concatBytes([m0.ch, m0.sh, m0.ee, m0.cert, m0.cv]));
  const serverFinished = step(
    's-fin',
    'Server Finished',
    'HMAC(finished_key(s_hs), SHA-256(CH…CertificateVerify))',
    await h.hmac(sFinKey, thCv),
    msg('keys.sFin'),
  );
  const m1 = tls13Messages(site, config, { ...draft, serverFinished });
  const thSf = await h.hash(concatBytes([m1.ch, m1.sh, m1.ee, m1.cert, m1.cv, m1.sfin]));
  const cFinKey = await h.expandLabel(cHs, 'finished', new Uint8Array(0), 32);
  const clientFinished = step(
    'c-fin',
    'Client Finished',
    'HMAC(finished_key(c_hs), SHA-256(CH…server Finished))',
    await h.hmac(cFinKey, thSf),
    msg('keys.cFin'),
  );

  const derived2 = await h.deriveSecret(hs, 'derived', new Uint8Array(0));
  const master = step(
    'master',
    'Master secret',
    'HKDF-Extract(Derive-Secret(hs, "derived", ""), 0)',
    await h.extract(derived2, zeros),
    msg('keys.master'),
  );
  const cAp = step(
    'c-ap',
    'Client application traffic secret',
    'HKDF-Expand-Label(master, "c ap traffic", th, 32)',
    await h.expandLabel(master, 'c ap traffic', thSf, 32),
    msg('keys.cAp'),
  );
  const sAp = step(
    's-ap',
    'Server application traffic secret',
    'HKDF-Expand-Label(master, "s ap traffic", th, 32)',
    await h.expandLabel(master, 's ap traffic', thSf, 32),
    msg('keys.sAp'),
  );
  const cApKey = step(
    'c-ap-key',
    'Client application key',
    'HKDF-Expand-Label(c_ap, "key", "", 16)',
    await h.expandLabel(cAp, 'key', new Uint8Array(0), 16),
    msg('keys.key'),
  );
  const cApIv = await h.expandLabel(cAp, 'iv', new Uint8Array(0), 12);
  const sApKey = await h.expandLabel(sAp, 'key', new Uint8Array(0), 16);
  const sApIv = await h.expandLabel(sAp, 'iv', new Uint8Array(0), 12);

  const trafficKeys: TrafficKey[] = [
    { side: 'client', epoch: 'handshake', key: cHsKey, iv: cHsIv },
    { side: 'server', epoch: 'handshake', key: sHsKey, iv: sHsIv },
    { side: 'client', epoch: 'application', key: cApKey, iv: cApIv },
    { side: 'server', epoch: 'application', key: sApKey, iv: sApIv },
  ];
  const aesKeys = new Map<string, Key>();
  for (const k of trafficKeys) {
    aesKeys.set(
      `${k.side}:${k.epoch}`,
      await s.importKey('raw', k.key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    );
  }
  const cipher = async (input: RecordCipherInput): Promise<Bytes> => {
    const tk = trafficKeys.find((k) => k.side === input.side && k.epoch === input.epoch);
    const key = aesKeys.get(`${input.side}:${input.epoch}`);
    if (!tk || !key) throw new Error('missing traffic key');
    return new Uint8Array(
      await s.encrypt(
        {
          name: 'AES-GCM',
          iv: nonceFor(tk.iv, input.seqNum),
          additionalData: input.aad,
          tagLength: 128,
        },
        key,
        input.inner,
      ),
    );
  };

  const final = tls13Messages(site, config, { ...draft, serverFinished, clientFinished });
  const sealer = new Sealer('1.3', () => new Uint8Array(8));
  const hsWrites = tls13Writes(final);
  const handshake = [];
  for (const w of hsWrites) handshake.push(await sealWriteAsync(sealer, w, false, cipher));
  const requests = [];
  for (const w of app.requests) requests.push(await sealWriteAsync(sealer, w, true, cipher));
  const responses = [];
  for (const w of app.responses) responses.push(await sealWriteAsync(sealer, w, true, cipher));

  const main: SealedConnection = {
    tls: '1.3',
    http: config.httpVersion,
    mode: 'webcrypto',
    handshake,
    requests,
    responses,
    order: app.order,
    h2Triggers: app.h2Triggers,
    bodies: app.bodies,
    keySchedule: steps,
    trafficKeys,
  };
  return {
    mode: 'webcrypto',
    main,
    origin: buildOrigin(config, rng, app.bodies),
    fallbackReason: null,
  };
}

export interface RealDecryptRecord {
  readonly recordIndex: number;
  readonly side: 'client' | 'server';
  readonly epoch: 'handshake' | 'application';
  readonly seqNum: number;
  readonly key: string;
  readonly nonce: string;
  readonly plaintext: Uint8Array;
  readonly matches: boolean;
}

export interface RealDecryptResult {
  readonly records: readonly RealDecryptRecord[];
  readonly error: string | null;
}

/** Really decrypts the encrypted records a packet carries, with AES-128-GCM and the derived keys. */
export async function realDecrypt(sim: Simulation, id: number): Promise<RealDecryptResult | null> {
  const { material, full } = sim.internals;
  const keys = material.main.trafficKeys;
  const s = subtle();
  const rec = full.w.packets[id - 1];
  if (!keys || !s || !rec || rec.meta.connId !== 1 || !rec.meta.tls) return null;
  const side: 'client' | 'server' = rec.from === 'laptop' ? 'client' : 'server';
  const off = rec.meta.tls.streamOffset;
  const spans = rec.meta.tls.spans.filter(
    (sp) =>
      sp.end > off &&
      sp.start < off + rec.payload.length &&
      sp.rec.encrypted &&
      sp.rec.epoch !== 'plain',
  );
  const out: RealDecryptRecord[] = [];
  try {
    for (const sp of spans) {
      const r = sp.rec;
      const epoch = r.epoch === 'handshake' ? 'handshake' : 'application';
      const tk = keys.find((k) => k.side === side && k.epoch === epoch);
      if (!tk) continue;
      const key = await s.importKey('raw', tk.key, { name: 'AES-GCM' }, false, ['decrypt']);
      const nonce = nonceFor(tk.iv, r.seqNum);
      // The record exactly as it travels on the wire: 5-byte header (the AAD), then ciphertext ‖ tag.
      const header = r.bytes.slice(0, 5);
      const body = r.bytes.slice(5);
      const plain = new Uint8Array(
        await s.decrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
          key,
          body,
        ),
      );
      const expected = concatBytes([r.plaintext, Uint8Array.of(r.innerType)]);
      out.push({
        recordIndex: sp.index,
        side,
        epoch,
        seqNum: r.seqNum,
        key: hex(tk.key),
        nonce: hex(nonce),
        plaintext: plain,
        matches: bytesEqual(plain, expected),
      });
    }
    return { records: out, error: null };
  } catch (e) {
    return { records: out, error: e instanceof Error ? e.message : String(e) };
  }
}
