import { DEFAULT_CONFIG, type ScenarioConfig, type SiteId } from '../model';
import { SITE_IDS } from '../content/sites';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Fills defaults and clamps every field into its valid range. */
export function normalizeConfig(partial: Partial<ScenarioConfig> = {}): ScenarioConfig {
  const c = { ...DEFAULT_CONFIG, ...partial };
  return {
    seed: Number.isFinite(c.seed) ? Math.trunc(c.seed) >>> 0 : DEFAULT_CONFIG.seed,
    site: (SITE_IDS as readonly string[]).includes(c.site) ? (c.site as SiteId) : 'example.com',
    rttScale: clamp(Number(c.rttScale) || 1, 0.1, 10),
    lossRate: clamp(Number(c.lossRate) || 0, 0, 0.1),
    tlsVersion: c.tlsVersion === '1.2' ? '1.2' : '1.3',
    httpVersion: c.httpVersion === '2' ? '2' : '1.1',
    cdn: Boolean(c.cdn),
    warmDnsCache:
      c.warmDnsCache === 'resolver' || c.warmDnsCache === 'browser' ? c.warmDnsCache : 'cold',
    ns1Timeout: Boolean(c.ns1Timeout),
    inlineCriticalCss: Boolean(c.inlineCriticalCss),
  };
}

/** Converts a base RTT in ms (laptop ↔ server) into the rttScale the topology understands. */
export const BASE_RTT_MS = 24;
