import { describe, expect, it } from 'vitest';
import { createSimulation, runSelfTest, SITE_IDS, type ScenarioConfig } from '../index';

const ms = (us: number | null): string => (us === null ? '—' : (us / 1000).toFixed(3));

function digest(cfg: Partial<ScenarioConfig>): string {
  const run = createSimulation(cfg).getRun();
  const lines = [
    `marks ${Object.entries(run.marks)
      .map(([k, v]) => `${k}=${ms(v)}`)
      .join(' ')} end=${ms(run.endUs)}`,
    ...run.packets.map(
      (p) =>
        `#${p.id} ${ms(p.tUs)} ${p.from}>${p.to} ${p.proto} ${p.stop} ${p.size}B ${p.name}${p.lost ? ' LOST' : ''}`,
    ),
  ];
  return lines.join('\n');
}

describe('full-run snapshots', () => {
  it.each(SITE_IDS)('%s, seed 42', (site) => {
    expect(digest({ site, seed: 42 })).toMatchSnapshot();
  });

  it('TLS 1.2 + HTTP/2, seed 7', () => {
    expect(digest({ seed: 7, tlsVersion: '1.2', httpVersion: '2' })).toMatchSnapshot();
  });
});

const variants: [string, Partial<ScenarioConfig>][] = [
  ['default', {}],
  ['tls 1.2', { tlsVersion: '1.2' }],
  ['http/2', { httpVersion: '2' }],
  ['no cdn', { cdn: false }],
  ['far', { site: 'far.example' }],
  ['heavy', { site: 'heavy.example' }],
  ['heavy h2', { site: 'heavy.example', httpVersion: '2' }],
  ['static', { site: 'static.example' }],
  ['warm resolver', { warmDnsCache: 'resolver' }],
  ['warm browser', { warmDnsCache: 'browser' }],
  ['ns1 timeout', { ns1Timeout: true }],
  ['inline css', { inlineCriticalCss: true }],
  ['10% loss', { lossRate: 0.1, seed: 3 }],
  ['3× rtt', { rttScale: 3 }],
];

describe('scenarios', () => {
  it.each(variants)('%s passes every self-check and loads', (_n, cfg) => {
    const sim = createSimulation({ seed: 42, ...cfg });
    expect(runSelfTest(sim).filter((r) => !r.pass)).toEqual([]);
    expect(sim.getRun().marks.loadUs).not.toBeNull();
  });

  it('a cold example.com run paints near 200 ms', () => {
    const fp = createSimulation({ seed: 42 }).getRun().marks.firstPaintUs ?? 0;
    expect(fp).toBeGreaterThan(170_000);
    expect(fp).toBeLessThan(260_000);
  });

  it('DNS takes 8 packets cold, 2 with a warm resolver, 0 with a warm browser cache', () => {
    const count = (w: ScenarioConfig['warmDnsCache']): number =>
      createSimulation({ warmDnsCache: w })
        .getRun()
        .packets.filter((p) => p.flow === 'dns').length;
    expect([count('cold'), count('resolver'), count('browser')]).toEqual([8, 2, 0]);
  });

  it('ns1 timeout makes the resolver retry ns2 after 400 ms', () => {
    const run = createSimulation({ ns1Timeout: true }).getRun();
    const to = run.packets.filter((p) => p.to === 'ns1' || p.to === 'ns2');
    expect(to.map((p) => p.to)).toEqual(['ns1', 'ns2']);
    expect((to[1]?.tUs ?? 0) - (to[0]?.tUs ?? 0)).toBeGreaterThanOrEqual(400_000);
  });

  it('inline critical CSS moves first paint earlier', () => {
    const a = createSimulation({}).getRun().marks.firstPaintUs ?? 0;
    const b = createSimulation({ inlineCriticalCss: true }).getRun().marks.firstPaintUs ?? 0;
    expect(b).toBeLessThan(a - 10_000);
  });

  it('TLS 1.2 needs one more round trip than TLS 1.3', () => {
    const a = createSimulation({ tlsVersion: '1.3' }).getRun().marks;
    const b = createSimulation({ tlsVersion: '1.2' }).getRun().marks;
    const rtt = 24_000;
    expect(
      (b.tlsDoneUs ?? 0) - (b.connectedUs ?? 0) - ((a.tlsDoneUs ?? 0) - (a.connectedUs ?? 0)),
    ).toBeGreaterThan(rtt * 0.8);
  });

  it('a larger RTT makes the whole load slower', () => {
    const a = createSimulation({ rttScale: 1 }).getRun().totalUs;
    const b = createSimulation({ rttScale: 2 }).getRun().totalUs;
    expect(b).toBeGreaterThan(a * 1.5);
  });

  it('TTL is 64 on the way out and decremented once per router hop on arrival', () => {
    const sim = createSimulation({});
    const syn = sim.getRun().packets.find((p) => p.name === 'SYN');
    const synack = sim.getRun().packets.find((p) => p.name === 'SYN, ACK');
    const ttl = (id: number): string | undefined =>
      sim
        .getPacket(id)
        ?.layers.find((l) => l.id === 'ipv4')
        ?.fields.find((f) => f.id === 'ipv4.ttl')?.display;
    expect(ttl(syn?.id ?? 0)).toBe('64');
    expect(ttl(synack?.id ?? 0)).toBe('59'); // router + 4 ISP hops
  });

  it('encrypted records carry ciphertext of plaintext + type byte + 16-byte tag', () => {
    const sim = createSimulation({});
    const get = sim.getRun().packets.find((p) => p.name === 'GET /');
    const d = sim.getPacket(get?.id ?? 0);
    const dec = d?.decrypted[0];
    expect(dec).toBeDefined();
    const rec = d?.layers.find((l) => l.name === 'TLS record (encrypted)');
    const len = Number(rec?.fields.find((f) => f.name === 'Length')?.display.split(' ')[0]);
    expect(len).toBe((dec?.plaintext.length ?? 0) + 16);
    expect(new TextDecoder().decode(dec?.plaintext).startsWith('GET / HTTP/1.1')).toBe(true);
  });
});

describe('playback API', () => {
  it('step back re-simulates to the previous event', () => {
    const sim = createSimulation({});
    for (let i = 0; i < 25; i++) sim.stepForward();
    const s25 = sim.getSnapshot();
    sim.stepForward();
    sim.stepBack();
    const again = sim.getSnapshot();
    expect(again.cursor).toBe(s25.cursor);
    expect(again.nowUs).toBe(s25.nowUs);
    expect(JSON.stringify(again.dnsCache)).toBe(JSON.stringify(s25.dnsCache));
  });

  it('runTo backwards gives the same state as running forward', () => {
    const sim = createSimulation({});
    sim.runTo(150_000);
    const a = JSON.stringify(sim.getState());
    sim.runTo(300_000);
    sim.runTo(150_000);
    expect(JSON.stringify(sim.getState())).toBe(a);
  });

  it('the DOM grows as HTML records arrive', () => {
    const sim = createSimulation({});
    const fb = sim.getRun().marks.firstByteUs ?? 0;
    const count = (n: { children: readonly unknown[] } | null): number =>
      n
        ? 1 +
          n.children.reduce<number>((s, c) => s + count(c as { children: readonly unknown[] }), 0)
        : 0;
    sim.runTo(fb - 1);
    const before = count(sim.getSnapshot().render.domTree);
    sim.runTo(sim.getRun().endUs);
    const after = count(sim.getSnapshot().render.domTree);
    expect(before).toBe(1);
    expect(after).toBeGreaterThan(15);
  });

  it('snapshots are structured-clone safe', () => {
    const sim = createSimulation({});
    sim.runTo(250_000);
    expect(() => structuredClone(sim.getSnapshot())).not.toThrow();
    expect(() => structuredClone(sim.getPacket(13))).not.toThrow();
  });

  it('notifies subscribers', () => {
    const sim = createSimulation({});
    let n = 0;
    const off = sim.subscribe(() => n++);
    sim.runTo(1000);
    sim.stepForward();
    off();
    sim.stepForward();
    expect(n).toBe(2);
  });
});
