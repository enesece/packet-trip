import * as Comlink from 'comlink';
import type {
  KeyScheduleStep,
  PacketDetail,
  RunInfo,
  ScenarioConfig,
  SelfTestResult,
} from '@packet-trip/engine';
import type { CryptoChoice, EngineApi, LoadResult } from './engine.worker';
import type { RealDecryptResult } from '@packet-trip/engine';

export type SimState = NonNullable<LoadResult['state']>;

export interface SimView {
  readonly run: RunInfo | null;
  readonly state: SimState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly fallbackReason: string | null;
  readonly keySchedule: readonly KeyScheduleStep[] | null;
  /** Bumps on every new run (used to reset per-run caches). */
  readonly runId: number;
}

const EMPTY: SimView = {
  run: null,
  state: null,
  loading: false,
  error: null,
  fallbackReason: null,
  keySchedule: null,
  runId: 0,
};

/**
 * Talks to the engine worker. Seeks are coalesced: while one is in flight, only the latest
 * requested time is kept, so dragging the timeline never queues up stale work.
 */
export class SimClient {
  private readonly api: Comlink.Remote<EngineApi>;
  private view: SimView = EMPTY;
  private readonly listeners = new Set<() => void>();
  private seeking = false;
  private pendingSeek: number | null = null;
  private packetCache = new Map<number, Promise<PacketDetail | null>>();
  private loadSeq = 0;

  constructor(worker: Worker) {
    this.api = Comlink.wrap<EngineApi>(worker);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getView = (): SimView => this.view;

  private set(patch: Partial<SimView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  async setFontTable(table: Parameters<EngineApi['setFontTable']>[0]): Promise<void> {
    await this.api.setFontTable(table);
  }

  async load(config: ScenarioConfig, crypto: CryptoChoice): Promise<RunInfo | null> {
    const seq = ++this.loadSeq;
    this.set({ loading: true, error: null });
    try {
      const r = await this.api.load(config, crypto);
      if (seq !== this.loadSeq) return null;
      this.packetCache = new Map();
      this.pendingSeek = null;
      this.set({
        run: r.run,
        state: r.state,
        loading: false,
        fallbackReason: r.fallbackReason,
        keySchedule: r.keySchedule,
        runId: this.view.runId + 1,
      });
      return r.run;
    } catch (e) {
      if (seq === this.loadSeq)
        this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  seek(t: number): void {
    if (this.seeking) {
      this.pendingSeek = t;
      return;
    }
    this.seeking = true;
    const runId = this.view.runId;
    void this.api
      .runTo(t)
      .then((state) => {
        if (state && runId === this.view.runId) this.set({ state });
      })
      .finally(() => {
        this.seeking = false;
        const next = this.pendingSeek;
        this.pendingSeek = null;
        if (next !== null) this.seek(next);
      });
  }

  async step(dir: 1 | -1): Promise<number | null> {
    const state = await this.api.step(dir);
    if (!state) return null;
    this.set({ state });
    return state.nowUs;
  }

  getPacket(id: number): Promise<PacketDetail | null> {
    let p = this.packetCache.get(id);
    if (!p) {
      p = this.api.getPacket(id);
      this.packetCache.set(id, p);
    }
    return p;
  }

  selfTest(): Promise<SelfTestResult[]> {
    return this.api.selfTest();
  }

  totalFor(config: ScenarioConfig): Promise<number> {
    return this.api.totalFor(config);
  }

  decrypt(id: number): Promise<RealDecryptResult | null> {
    return this.api.decrypt(id);
  }
}

let client: SimClient | null = null;

export function getSimClient(): SimClient {
  if (!client) {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
      name: 'packet-trip-engine',
    });
    client = new SimClient(worker);
  }
  return client;
}

/** For tests: inject a client (e.g. one backed by an in-process engine). */
export function setSimClient(c: SimClient | null): void {
  client = c;
}
