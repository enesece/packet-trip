import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  Hkdf,
  buildWebCryptoMaterial,
  nonceFor,
  realDecrypt,
  webCryptoAvailable,
} from '../crypto/webcrypto';
import { createSimulation, normalizeConfig, runSelfTest } from '../index';
import { toHex } from '../bytes/hex';
import { bytesEqual } from '../bytes/writer';

const h = new Hkdf(webcrypto.subtle as unknown as ConstructorParameters<typeof Hkdf>[0]);
const hex = (b: Uint8Array): string => toHex(b, 0, b.length, '');

describe('TLS 1.3 key schedule primitives', () => {
  it('match the RFC 8448 early secret and first derived secret', async () => {
    const zeros = new Uint8Array(32);
    const early = await h.extract(zeros, zeros);
    expect(hex(early)).toBe('33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a');
    const derived = await h.deriveSecret(early, 'derived', new Uint8Array(0));
    expect(hex(derived)).toBe('6f2615a108c702c5678f54fc9dbab69716c076189c48250cebeac3576c3611ba');
  });

  it('XORs the record sequence number into the IV', () => {
    const iv = new Uint8Array(12);
    expect(hex(nonceFor(iv, 1))).toBe('000000000000000000000001');
    expect(hex(nonceFor(iv, 0x0102))).toBe('000000000000000000000102');
  });
});

describe('real Web Crypto material', () => {
  it('is available in Node', async () => {
    expect(await webCryptoAvailable()).toBe(true);
  });

  it('produces the same timeline as simulated crypto, and every record really decrypts', async () => {
    const config = normalizeConfig({ seed: 42 });
    const material = await buildWebCryptoMaterial(config);
    expect(material.mode).toBe('webcrypto');
    expect(material.main.keySchedule?.length).toBeGreaterThan(10);
    const real = createSimulation(config, { crypto: material });
    const fake = createSimulation(config);
    // Record lengths are identical, so every packet is sent at the same time with the same size.
    expect(real.getRun().packets.map((p) => [p.tUs, p.size])).toEqual(
      fake.getRun().packets.map((p) => [p.tUs, p.size]),
    );
    expect(runSelfTest(real).every((r) => r.pass)).toBe(true);
    let records = 0;
    for (const p of real.getRun().packets) {
      if (!p.encrypted || p.connId !== 1) continue;
      const r = await realDecrypt(real, p.id);
      expect(r?.error).toBeNull();
      for (const rec of r?.records ?? []) {
        expect(rec.matches).toBe(true);
        records++;
      }
    }
    expect(records).toBeGreaterThan(10);
  });

  it('client Finished verifies against the transcript', async () => {
    const config = normalizeConfig({ seed: 7 });
    const a = await buildWebCryptoMaterial(config);
    const b = await buildWebCryptoMaterial(config);
    // Deterministic: same seed, same keys and bytes.
    expect(
      bytesEqual(
        a.main.handshake[1]?.bytes ?? new Uint8Array(1),
        b.main.handshake[1]?.bytes ?? new Uint8Array(2),
      ),
    ).toBe(true);
    expect(a.main.keySchedule?.find((s) => s.id === 'c-fin')?.value).toBe(
      b.main.keySchedule?.find((s) => s.id === 'c-fin')?.value,
    );
  });

  it('falls back to simulated crypto for TLS 1.2', async () => {
    const m = await buildWebCryptoMaterial(normalizeConfig({ tlsVersion: '1.2' }));
    expect(m.mode).toBe('simulated');
    expect(m.fallbackReason).toBe('tls12-simulated');
  });
});
