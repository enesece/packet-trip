import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSimulation,
  runSelfTest,
  type Field,
  type LayerNode,
  type Msg,
  type ScenarioConfig,
} from '@packet-trip/engine';
import en from '../i18n/en.json';
import tr from '../i18n/tr.json';

const EN = en as Record<string, string>;
const TR = tr as Record<string, string>;
const placeholders = (s: string): string[] =>
  [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1] ?? '').sort();

function engineKeys(): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  const add = (m: Msg | undefined): void => {
    if (!m) return;
    const s = keys.get(m.key) ?? new Set<string>();
    Object.keys(m.params ?? {}).forEach((p) => s.add(p));
    keys.set(m.key, s);
  };
  const visitF = (f: Field): void => {
    add(f.meaning);
    add({ key: f.nameKey, ...(f.nameParams ? { params: f.nameParams } : {}) });
    f.children?.forEach(visitF);
  };
  const visitL = (l: LayerNode): void => {
    add(l.summary);
    l.fields.forEach(visitF);
  };
  const cfgs: Partial<ScenarioConfig>[] = [
    {},
    { tlsVersion: '1.2', httpVersion: '2' },
    { site: 'heavy.example' },
    { warmDnsCache: 'resolver' },
    { warmDnsCache: 'browser' },
    { ns1Timeout: true },
    { inlineCriticalCss: true },
    { lossRate: 0.1, seed: 3 },
  ];
  for (const c of cfgs) {
    const sim = createSimulation(c);
    const run = sim.getRun();
    run.events.forEach((e) => add(e.msg));
    for (const p of run.packets) {
      add(p.nameMsg);
      add(p.story);
      const d = sim.getPacket(p.id);
      d?.layers.forEach(visitL);
      d?.decrypted.forEach((r) => r.layers.forEach(visitL));
    }
    runSelfTest(sim).forEach((r) => add(r.detail));
  }
  return keys;
}

describe('translations', () => {
  it('cover every message the engine emits, in English and Turkish, with the same placeholders', () => {
    const missing: string[] = [];
    for (const [key, params] of engineKeys()) {
      for (const [lang, dict] of [
        ['en', EN],
        ['tr', TR],
      ] as const) {
        const v = dict[key];
        if (v === undefined) {
          missing.push(`${lang}:${key}`);
          continue;
        }
        for (const p of placeholders(v))
          if (!params.has(p)) missing.push(`${lang}:${key} uses {{${p}}} the engine doesn't send`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('en and tr have the same keys and placeholders', () => {
    expect(Object.keys(TR).sort()).toEqual(Object.keys(EN).sort());
    const diff = Object.keys(EN).filter(
      (k) => placeholders(EN[k] ?? '').join() !== placeholders(TR[k] ?? '').join(),
    );
    expect(diff).toEqual([]);
  });

  it('every literal t("…") key in the UI exists', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !f.includes('.test.')) files.push(p);
      }
    };
    walk(join(__dirname, '..'));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([^'$]+)'/g))
        if (m[1]) used.add(m[1]);
    }
    const plural = (k: string): boolean =>
      EN[`${k}_one`] !== undefined && EN[`${k}_other`] !== undefined;
    expect([...used].filter((k) => EN[k] === undefined && !plural(k))).toEqual([]);
  });
});
