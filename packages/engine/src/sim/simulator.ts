import type {
  DnsLane,
  NodeId,
  PacketDetail,
  PacketSummary,
  PipelineStep,
  RenderState,
  ResourceTiming,
  ScenarioConfig,
  SimEvent,
  SimSnapshot,
  Stop,
  StopId,
} from '../model';
import { STOP_IDS } from '../model';
import { getSite, type SiteDef } from '../content/sites';
import { buildSimulatedMaterial } from '../crypto/simulated';
import type { CryptoMaterial } from '../crypto/types';
import {
  approximateMeasurer,
  tableMeasurer,
  type FontTable,
  type TextMeasurer,
} from '../browser/measure';
import { freeze } from '../browser/dom';
import { decodeFrame, encodeFrame, type DecodedFrame, type FrameSpec } from '../proto/packet';
import { concatBytes } from '../bytes/writer';
import { linkInfo } from '../net/topology';
import { createRng } from './rng';
import { normalizeConfig } from './scenario';
import { World, type PacketRec } from './world';
import { DnsCaches, startLookup } from './dns-actors';
import { VIEWPORT, WebActors } from './web-actors';

export interface SimulationOptions {
  /** Pre-sealed TLS material (e.g. from real Web Crypto). Defaults to simulated crypto. */
  readonly crypto?: CryptoMaterial;
  /** Text measurement for layout; a table measured with canvas in the web app. */
  readonly measure?: TextMeasurer;
  readonly fontTable?: FontTable;
}

/** Everything about a run that does not depend on the current time. */
export interface RunInfo {
  readonly seed: number;
  readonly config: ScenarioConfig;
  readonly endUs: number;
  readonly packets: readonly PacketSummary[];
  readonly events: readonly SimEvent[];
  readonly windows: readonly {
    readonly id: StopId;
    readonly startUs: number;
    readonly endUs: number;
  }[];
  readonly marks: SimSnapshot['marks'];
  readonly resources: readonly ResourceTiming[];
  readonly site: SimSnapshot['site'];
  readonly dnsLanes: readonly DnsLane[];
  readonly nodes: SimSnapshot['nodes'];
  readonly links: SimSnapshot['links'];
  readonly cryptoMode: SimSnapshot['cryptoMode'];
  readonly pipelineTimes: Readonly<Record<PipelineStep, number | null>>;
  readonly firstPaintUs: number | null;
  readonly loadUs: number | null;
  readonly fontSwapUs: number | null;
  readonly domContentLoadedUs: number | null;
  readonly totalUs: number;
}

export interface Simulation {
  readonly config: ScenarioConfig;
  runTo(timeUs: number): void;
  stepForward(): void;
  stepBack(): void;
  getSnapshot(): SimSnapshot;
  getRun(): RunInfo;
  getState(): Omit<SimSnapshot, keyof RunInfo | 'stops' | 'packetsSent'> & {
    readonly stops: readonly Stop[];
    readonly packetsSent: number;
    readonly nowUs: number;
  };
  getPacket(id: number): PacketDetail | null;
  subscribe(listener: () => void): () => void;
  /** Internal access for checks and tests. */
  readonly internals: SimInternals;
}

export interface SimInternals {
  readonly material: CryptoMaterial;
  readonly full: Instance;
  frameOf(id: number): { bytes: Uint8Array; decoded: DecodedFrame; spec: FrameSpec } | null;
}

export interface Instance {
  readonly w: World;
  readonly web: WebActors;
  readonly caches: DnsCaches;
}

const MAX_TASKS = 2_000_000;

function makeInstance(
  config: ScenarioConfig,
  site: SiteDef,
  material: CryptoMaterial,
  measure: TextMeasurer,
): Instance {
  const w = new World(config, site);
  const web = new WebActors(w, material, measure);
  const caches = new DnsCaches();
  startLookup(w, caches, site.host, web.serverAddress, () => {
    web.marks.dnsDoneUs = w.now;
    w.log('state', 'application', 'laptop', {
      key: 'ev.dns.done',
      params: { host: site.host, address: web.serverAddress },
    });
    web.connect();
  });
  return { w, web, caches };
}

export function createSimulation(
  partial: Partial<ScenarioConfig> = {},
  opts: SimulationOptions = {},
): Simulation {
  const config = normalizeConfig(partial);
  const site = getSite(config.site, config.inlineCriticalCss);
  const material =
    opts.crypto ?? buildSimulatedMaterial(config, createRng(config.seed).fork('crypto'));
  const measure =
    opts.measure ?? (opts.fontTable ? tableMeasurer(opts.fontTable) : approximateMeasurer);

  // 1. A full run, for the timeline, the packet list and everything "future".
  const full = makeInstance(config, site, material, measure);
  let guard = 0;
  // Event counts after each task that logged something: the positions "step" moves between.
  const boundaries: number[] = [full.w.events.length];
  while (full.w.step()) {
    if (++guard > MAX_TASKS) throw new Error('simulation did not finish');
    if (full.w.events.length > (boundaries[boundaries.length - 1] ?? 0))
      boundaries.push(full.w.events.length);
  }
  const run = buildRunInfo(config, site, full, material);
  const summaries = run.packets;

  // 2. The live instance that follows the playhead.
  let cur = makeInstance(config, site, material, measure);
  let viewUs = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());

  const reset = (): void => {
    cur = makeInstance(config, site, material, measure);
    viewUs = 0;
  };

  const runTo = (t: number): void => {
    const target = Math.max(0, Math.min(t, run.endUs));
    if (target < cur.w.now) reset();
    for (;;) {
      const nt = cur.w.peekTime();
      if (nt === null || nt > target) break;
      cur.w.step();
    }
    viewUs = target;
  };

  const runToEventCount = (n: number): void => {
    if (cur.w.events.length > n) reset();
    while (cur.w.events.length < n) {
      if (!cur.w.step()) break;
    }
    // Include other tasks at the same instant so the state is consistent.
    const last = cur.w.events[cur.w.events.length - 1];
    viewUs = last ? last.tUs : 0;
  };

  const frameOf = (
    id: number,
  ): { bytes: Uint8Array; decoded: DecodedFrame; spec: FrameSpec } | null => {
    const rec = full.w.packets[id - 1];
    if (!rec || rec.evicted) return null;
    const { spec, capturedAt } = captureSpec(full.w, rec);
    const bytes = encodeFrame(spec);
    const decoded = decodeFrame(bytes, decodeContext(full.w, rec, spec));
    void capturedAt;
    return { bytes, decoded, spec };
  };

  const getState: Simulation['getState'] = () => {
    const now = viewUs;
    const cursor = lastEventIndex(run.events, cur.w.events.length);
    return {
      nowUs: now,
      cursor,
      stops: stopsAt(run, now),
      packetsSent: countSent(summaries, now),
      dnsCache: cur.caches.snapshot(now),
      connections: cur.web.connections.map((c) => c.info()),
      render: renderState(cur.web, run, now),
    };
  };

  const sim: Simulation = {
    config,
    runTo(t) {
      runTo(t);
      notify();
    },
    stepForward() {
      const n = cur.w.events.length;
      const next = boundaries.find((b) => b > n);
      if (next !== undefined) runToEventCount(next);
      notify();
    },
    stepBack() {
      const n = cur.w.events.length;
      let prev = boundaries[0] ?? 1;
      for (const b of boundaries) if (b < n) prev = b;
      runToEventCount(prev);
      notify();
    },
    getRun: () => run,
    getState,
    getSnapshot() {
      const s = getState();
      return {
        seed: run.seed,
        config: run.config,
        endUs: run.endUs,
        packets: run.packets,
        events: run.events,
        marks: run.marks,
        site: run.site,
        dnsLanes: run.dnsLanes,
        nodes: run.nodes,
        links: run.links,
        cryptoMode: run.cryptoMode,
        ...s,
      };
    },
    getPacket(id) {
      const f = frameOf(id);
      const summary = summaries[id - 1];
      if (!f || !summary) return null;
      const plain = f.decoded.decrypted.map((d) => d.plaintext);
      const rec = full.w.packets[id - 1] as PacketRec;
      return {
        summary,
        bytes: f.bytes,
        layers: f.decoded.layers,
        decrypted: f.decoded.decrypted,
        ...(plain.length > 0 ? { plaintext: concatBytes(plain) } : {}),
        cryptoMode: material.mode,
        capturedAt: captureSpec(full.w, rec).capturedAt,
      };
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    internals: { material, full, frameOf },
  };
  return sim;
}

function lastEventIndex(_events: readonly SimEvent[], processed: number): number {
  return processed - 1;
}

function countSent(ps: readonly PacketSummary[], now: number): number {
  let lo = 0;
  let hi = ps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ps[mid]?.tUs ?? 0) <= now) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bytes as captured: on the laptop for its own traffic, otherwise at the receiver. */
export function captureSpec(w: World, rec: PacketRec): { spec: FrameSpec; capturedAt: NodeId } {
  const N = w.nodes;
  const atSender = rec.from === 'laptop' || rec.arriveUs === null;
  const path = rec.path;
  let ttl = 64;
  let ethSrc: string;
  let ethDst: string;
  let capturedAt: NodeId;
  if (atSender) {
    capturedAt = rec.from;
    ethSrc = N[rec.from].mac;
    ethDst = N[path[1] ?? rec.to].mac;
  } else {
    capturedAt = rec.to;
    ttl = 64 - w.routersOn(path);
    ethSrc = N[path[path.length - 2] ?? rec.from].mac;
    ethDst = N[rec.to].mac;
  }
  return {
    capturedAt,
    spec: {
      eth: { src: ethSrc, dst: ethDst, etherType: 0x0800 },
      ip: { dscp: 0, id: rec.ipId, df: true, ttl, src: rec.src, dst: rec.dst },
      l4: rec.l4,
      payload: rec.payload,
    },
  };
}

function decodeContext(
  w: World,
  rec: PacketRec,
  spec: FrameSpec,
): Parameters<typeof decodeFrame>[1] {
  const macNames: Record<string, string> = {};
  const hostNames: Record<string, string> = {};
  for (const n of Object.values(w.nodes)) {
    macNames[n.mac] = `@node:${n.id}`;
    hostNames[n.address] = `@node:${n.id}`;
  }
  const payloadStart = 14 + 20 + (spec.l4.kind === 'udp' ? 8 : 20 + tcpOptLen(spec));
  const tcp = rec.meta.tcp;
  const tls = rec.meta.tls;
  return {
    macNames,
    hostNames,
    ...(tcp
      ? {
          tcp: {
            isnSrc: tcp.isnSrc,
            ...(tcp.isnDst !== null ? { isnDst: tcp.isnDst } : {}),
            windowScaleSrc: tcp.wscaleSrc,
          },
        }
      : {}),
    ...(tls
      ? {
          tls: {
            version: tls.version,
            spans: tls.spans
              .filter(
                (s) => s.end > tls.streamOffset && s.start < tls.streamOffset + spec.payload.length,
              )
              .map((s) => ({
                absStart: payloadStart + (s.start - tls.streamOffset),
                absEnd: payloadStart + (s.end - tls.streamOffset),
                index: s.index,
                rec: s.rec,
              })),
          },
        }
      : {}),
  };
}

function tcpOptLen(spec: FrameSpec): number {
  if (spec.l4.kind !== 'tcp') return 0;
  let n = 0;
  for (const o of spec.l4.header.options) {
    n +=
      o.kind === 'eol' || o.kind === 'nop'
        ? 1
        : o.kind === 'mss'
          ? 4
          : o.kind === 'wscale'
            ? 3
            : o.kind === 'sack-permitted'
              ? 2
              : 2 + 8 * o.blocks.length;
  }
  return n;
}

const STOP_LAYER: Record<StopId, Stop['layer']> = {
  dns: 'application',
  tcp: 'transport',
  tls: 'security',
  request: 'application',
  response: 'application',
  render: 'browser',
};

function buildRunInfo(
  config: ScenarioConfig,
  site: SiteDef,
  full: Instance,
  material: CryptoMaterial,
): RunInfo {
  const { w, web } = full;
  const m = web.marks;
  const lastEvent = w.events[w.events.length - 1];
  const endUs = lastEvent ? lastEvent.tUs : 0;
  const load = m.loadUs ?? endUs;
  const bounds: [StopId, number, number][] = [];
  const dns = m.dnsDoneUs ?? 0;
  const tcp = m.connectedUs ?? dns;
  const tls = m.tlsDoneUs ?? tcp;
  const fb = m.firstByteUs ?? tls;
  const html = m.htmlDoneUs ?? fb;
  bounds.push(
    ['dns', 0, dns],
    ['tcp', dns, tcp],
    ['tls', tcp, tls],
    ['request', tls, fb],
    ['response', fb, html],
    ['render', html, load],
  );
  const windows = bounds.map(([id, startUs, e]) => ({ id, startUs, endUs: e }));
  const stopFor = (t: number, hint: StopId | null): StopId => {
    if (hint) return hint;
    for (const win of windows) if (t >= win.startUs && t < win.endUs) return win.id;
    return t >= load ? 'render' : 'dns';
  };
  const N = w.nodes;
  const packets: PacketSummary[] = w.packets.map((p) => ({
    id: p.id,
    tUs: p.tUs,
    arriveUs: p.arriveUs,
    from: p.from,
    to: p.to,
    topLayer: p.meta.topLayer,
    proto: p.meta.proto,
    name: p.meta.name,
    nameMsg: p.meta.nameMsg,
    size: p.size,
    direction: p.from === 'laptop' ? 'out' : p.to === 'laptop' ? 'in' : 'other',
    flow: p.meta.flow,
    connId: p.meta.connId,
    lost: p.lost,
    retransmit: p.meta.retransmit,
    encrypted: p.meta.encrypted,
    hops: p.hops.map((h) => ({ ...h })),
    stop: stopFor(p.tUs, p.meta.stopHint),
    dnsStep: p.meta.dnsStep,
    story: p.meta.story,
  }));
  const lanes: DnsLane[] = [
    { node: 'laptop', label: 'You', address: N.laptop.address },
    { node: 'resolver', label: 'Resolver', address: N.resolver.address },
    { node: 'root', label: 'Root', address: N.root.address },
    { node: 'tld', label: `.${site.tld}`, address: N.tld.address },
    { node: 'ns1', label: site.nsHosts[0].replace(/\.com$/, ''), address: N.ns1.address },
  ];
  if (config.ns1Timeout)
    lanes.push({
      node: 'ns2',
      label: site.nsHosts[1].replace(/\.com$/, ''),
      address: N.ns2.address,
    });
  const viaCdn = config.cdn && site.cdn;
  return {
    seed: config.seed,
    config,
    endUs,
    packets,
    events: w.events.slice(),
    windows,
    marks: {
      dnsDoneUs: m.dnsDoneUs,
      connectedUs: m.connectedUs,
      tlsDoneUs: m.tlsDoneUs,
      firstByteUs: m.firstByteUs,
      firstPaintUs: m.firstPaintUs,
      loadUs: m.loadUs,
    },
    resources: web.timings().sort((a, b) => a.requestUs - b.requestUs),
    site: { host: site.host, title: site.title, cdn: viaCdn, serverAddress: web.serverAddress },
    dnsLanes: lanes,
    nodes: Object.values(N).map(({ id, name, address, mac }) => ({ id, name, address, mac })),
    links: linkInfo(w.linkDefs),
    cryptoMode: material.mode,
    pipelineTimes: { ...web.pipelineTimes },
    firstPaintUs: m.firstPaintUs,
    loadUs: m.loadUs,
    fontSwapUs: m.fontSwapUs,
    domContentLoadedUs: m.dclUs,
    totalUs: m.loadUs ?? endUs,
  };
}

function stopsAt(run: RunInfo, now: number): Stop[] {
  return STOP_IDS.map((id) => {
    const win = run.windows.find((x) => x.id === id) ?? { startUs: 0, endUs: 0 };
    const state: Stop['state'] =
      now >= win.endUs && now > 0 ? 'done' : now >= win.startUs ? 'current' : 'future';
    return { id, layer: STOP_LAYER[id], startUs: win.startUs, endUs: win.endUs, state };
  }).map((s, i, arr) => {
    // Exactly one current stop: the first not-done one once the run has started.
    const firstOpen = arr.findIndex((x) => x.state !== 'done');
    if (s.state === 'current' && i !== firstOpen) return { ...s, state: 'future' as const };
    return s;
  });
}

const STEPS: PipelineStep[] = ['html', 'css', 'style', 'layout', 'paint', 'composite'];

function renderState(web: WebActors, run: RunInfo, now: number): RenderState {
  const frame = [...web.frames].reverse().find((f) => f.tUs <= now) ?? null;
  const times = run.pipelineTimes;
  const pipeline = {} as Record<PipelineStep, 'done' | 'current' | 'future'>;
  let currentAssigned = false;
  const htmlStarted = web.htmlStartUs !== null && web.htmlStartUs <= now;
  for (const s of STEPS) {
    const t = times[s];
    if (t !== null && t <= now) pipeline[s] = 'done';
    else if (!currentAssigned && htmlStarted) {
      pipeline[s] = 'current';
      currentAssigned = true;
    } else pipeline[s] = 'future';
  }
  return {
    domTree: freeze(web.tree.document, now),
    layoutBoxes: frame?.boxes ?? [],
    displayList: frame?.display ?? [],
    resources: run.resources,
    firstPaintUs: run.firstPaintUs,
    loadUs: run.loadUs,
    domContentLoadedUs: run.domContentLoadedUs,
    fontSwapUs: run.fontSwapUs,
    painted: frame !== null,
    fontLoaded: web.isFontLoaded,
    viewport: { w: VIEWPORT.w, h: VIEWPORT.h },
    pipeline,
    pipelineTimes: times,
    htmlBytesParsed: web.htmlBytesParsed,
    cssRules: web.cssom.ruleCount,
  };
}

export { VIEWPORT };
