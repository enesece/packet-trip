import * as Comlink from 'comlink';
import {
  buildWebCryptoMaterial,
  createSimulation,
  normalizeConfig,
  realDecrypt,
  runSelfTest,
  webCryptoAvailable,
  type FontTable,
  type PacketDetail,
  type RunInfo,
  type ScenarioConfig,
  type SelfTestResult,
  type Simulation,
  type KeyScheduleStep,
} from '@packet-trip/engine';

export type CryptoChoice = 'simulated' | 'webcrypto';

export interface LoadResult {
  readonly run: RunInfo;
  readonly state: ReturnType<Simulation['getState']>;
  readonly fallbackReason: string | null;
  readonly keySchedule: readonly KeyScheduleStep[] | null;
}

let sim: Simulation | null = null;
let fontTable: FontTable | undefined;

const api = {
  setFontTable(table: FontTable): void {
    fontTable = table;
  },

  async load(config: Partial<ScenarioConfig>, crypto: CryptoChoice): Promise<LoadResult> {
    let fallbackReason: string | null = null;
    let material;
    if (crypto === 'webcrypto' && config.tlsVersion !== '1.2') {
      if (await webCryptoAvailable()) {
        material = await buildWebCryptoMaterial(normalizeConfig(config));
        fallbackReason = material.fallbackReason;
      } else {
        fallbackReason = 'x25519-unavailable';
      }
    } else if (crypto === 'webcrypto') {
      fallbackReason = 'tls12-simulated';
    }
    sim = createSimulation(config, {
      ...(material ? { crypto: material } : {}),
      ...(fontTable ? { fontTable } : {}),
    });
    sim.runTo(0);
    return {
      run: sim.getRun(),
      state: sim.getState(),
      fallbackReason,
      keySchedule: sim.internals.material.main.keySchedule,
    };
  },

  /** Total load time for a config, without replacing the current run (what-if deltas). */
  totalFor(config: Partial<ScenarioConfig>): number {
    return createSimulation(config, fontTable ? { fontTable } : {}).getRun().totalUs;
  },

  runTo(t: number) {
    if (!sim) return null;
    sim.runTo(t);
    return sim.getState();
  },

  step(dir: 1 | -1) {
    if (!sim) return null;
    if (dir === 1) sim.stepForward();
    else sim.stepBack();
    return sim.getState();
  },

  getPacket(id: number): PacketDetail | null {
    return sim?.getPacket(id) ?? null;
  },

  selfTest(): SelfTestResult[] {
    return sim ? runSelfTest(sim) : [];
  },

  async decrypt(id: number) {
    if (!sim) return null;
    return realDecrypt(sim, id);
  },
};

export type EngineApi = typeof api;

Comlink.expose(api);
