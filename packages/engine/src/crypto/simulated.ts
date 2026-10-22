import type { ScenarioConfig } from '../model';
import type { Rng } from '../sim/rng';
import { getSite } from '../content/sites';
import { planApp, planOrigin } from '../content/plan';
import {
  simulatedMaterial,
  tls12Messages,
  tls12Writes,
  tls13Messages,
  tls13Writes,
} from '../content/handshake';
import { Sealer, sealWriteSync, type RecordCipher } from './seal';
import type { CryptoMaterial, SealedConnection, SealedOrigin } from './types';

/**
 * Phase 1 crypto: encrypted records carry pseudo-random bytes of exactly the right length.
 * The plaintext is kept beside them for the Decrypt toggle. No keys are ever derived.
 */
export function simulatedCipher(rng: Rng): RecordCipher {
  return (input) => rng.bytes(input.inner.length + 16);
}

export function buildSimulatedMaterial(
  config: ScenarioConfig,
  rng: Rng,
  fallbackReason: string | null = null,
): CryptoMaterial {
  const site = getSite(config.site, config.inlineCriticalCss);
  const viaCdn = config.cdn && site.cdn;
  const app = planApp(site, config, viaCdn, rng.fork('app'));
  const material = simulatedMaterial(site, config, rng);
  const hsWrites =
    config.tlsVersion === '1.3'
      ? tls13Writes(tls13Messages(site, config, material))
      : tls12Writes(tls12Messages(site, config, material));
  const nonceRng = rng.fork('explicit-nonce');
  const sealer = new Sealer(config.tlsVersion, () => nonceRng.bytes(8));
  const cipher = simulatedCipher(rng.fork('cipher'));
  const main: SealedConnection = {
    tls: config.tlsVersion,
    http: config.httpVersion,
    mode: 'simulated',
    handshake: hsWrites.map((w) => sealWriteSync(sealer, w, false, cipher)),
    requests: app.requests.map((w) => sealWriteSync(sealer, w, true, cipher)),
    responses: app.responses.map((w) => sealWriteSync(sealer, w, true, cipher)),
    order: app.order,
    h2Triggers: app.h2Triggers,
    bodies: app.bodies,
    keySchedule: null,
    trafficKeys: null,
  };
  return { mode: 'simulated', main, origin: buildOrigin(config, rng, app.bodies), fallbackReason };
}

export function buildOrigin(
  config: ScenarioConfig,
  rng: Rng,
  bodies: ReadonlyMap<string, Uint8Array>,
): SealedOrigin {
  const site = getSite(config.site, config.inlineCriticalCss);
  const o = planOrigin(site, rng, bodies);
  const sealer = new Sealer('1.3', () => new Uint8Array(8));
  const cipher = simulatedCipher(rng.fork('origin-cipher'));
  return {
    requests: o.requests.map((w) => sealWriteSync(sealer, w, true, cipher)),
    responses: o.responses.map((w) => sealWriteSync(sealer, w, true, cipher)),
    paths: o.paths,
  };
}
