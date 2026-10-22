import { DEFAULT_CONFIG, normalizeConfig, type ScenarioConfig } from '@packet-trip/engine';

/** Shareable state: /handshake?seed=42&packet=5&tls=1.2 … */
export function configFromSearch(search: string): {
  config: ScenarioConfig;
  packet: number | null;
  tMs: number | null;
} {
  const q = new URLSearchParams(search);
  const num = (k: string): number | undefined => (q.has(k) ? Number(q.get(k)) : undefined);
  const partial: Partial<Record<keyof ScenarioConfig, unknown>> = {};
  const seed = num('seed');
  if (seed !== undefined && Number.isFinite(seed)) partial.seed = seed;
  if (q.has('site')) partial.site = q.get('site');
  const rtt = num('rtt');
  if (rtt !== undefined) partial.rttScale = rtt;
  const loss = num('loss');
  if (loss !== undefined) partial.lossRate = loss / 100;
  if (q.has('tls')) partial.tlsVersion = q.get('tls');
  if (q.has('http')) partial.httpVersion = q.get('http');
  if (q.has('cdn')) partial.cdn = q.get('cdn') !== '0';
  if (q.has('dns')) partial.warmDnsCache = q.get('dns');
  if (q.has('ns1timeout')) partial.ns1Timeout = q.get('ns1timeout') === '1';
  if (q.has('inline')) partial.inlineCriticalCss = q.get('inline') === '1';
  const packet = num('packet');
  const tMs = num('t');
  return {
    tMs: tMs !== undefined && Number.isFinite(tMs) && tMs >= 0 ? tMs : null,
    config: normalizeConfig(partial as Partial<ScenarioConfig>),
    packet: packet !== undefined && Number.isInteger(packet) && packet > 0 ? packet : null,
  };
}

export function searchFromConfig(c: ScenarioConfig, packet: number | null): string {
  const q = new URLSearchParams();
  q.set('seed', String(c.seed));
  const d = DEFAULT_CONFIG;
  if (c.site !== d.site) q.set('site', c.site);
  if (c.rttScale !== d.rttScale) q.set('rtt', String(Math.round(c.rttScale * 100) / 100));
  if (c.lossRate !== d.lossRate) q.set('loss', String(Math.round(c.lossRate * 1000) / 10));
  if (c.tlsVersion !== d.tlsVersion) q.set('tls', c.tlsVersion);
  if (c.httpVersion !== d.httpVersion) q.set('http', c.httpVersion);
  if (c.cdn !== d.cdn) q.set('cdn', c.cdn ? '1' : '0');
  if (c.warmDnsCache !== d.warmDnsCache) q.set('dns', c.warmDnsCache);
  if (c.ns1Timeout) q.set('ns1timeout', '1');
  if (c.inlineCriticalCss) q.set('inline', '1');
  if (packet !== null) q.set('packet', String(packet));
  return `?${q.toString()}`;
}
