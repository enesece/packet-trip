import { create } from 'zustand';
import { DEFAULT_CONFIG, type ScenarioConfig } from '@packet-trip/engine';

export type Mode = 'story' | 'expert';
export type Theme = 'system' | 'light' | 'dark';
export type RenderView = 'boxes' | 'paint' | 'final';
export type CryptoChoice = 'simulated' | 'webcrypto';

export const SPEEDS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1] as const;
export const DEFAULT_SPEED = 0.05;

export interface UiState {
  mode: Mode;
  theme: Theme;
  config: ScenarioConfig;
  crypto: CryptoChoice;
  /** Whether the user has pressed Enter at least once (the run is "live"). */
  started: boolean;
  playing: boolean;
  speed: number;
  /** Virtual playhead in µs. */
  playheadUs: number;
  selectedPacket: number | null;
  /** Hovered byte range in the inspector, for two-way hex ↔ field sync. */
  hoverRange: readonly [number, number] | null;
  hoverField: string | null;
  activeLayer: string | null;
  decrypt: boolean;
  renderView: RenderView;
  selectedDomNode: number | null;
  /** Load time of the previous run, to show "+84 ms" after a what-if change. */
  previousTotalUs: number | null;
  previousFirstPaintUs: number | null;
  whatIfOpen: boolean;

  set: (patch: Partial<UiState>) => void;
  setConfig: (patch: Partial<ScenarioConfig>) => void;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('pt-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function readMode(): Mode {
  try {
    return localStorage.getItem('pt-mode') === 'expert' ? 'expert' : 'story';
  } catch {
    return 'story';
  }
}

export const useUi = create<UiState>((set) => ({
  mode: readMode(),
  theme: readTheme(),
  config: DEFAULT_CONFIG,
  crypto: 'webcrypto',
  started: false,
  playing: false,
  speed: DEFAULT_SPEED,
  playheadUs: 0,
  selectedPacket: null,
  hoverRange: null,
  hoverField: null,
  activeLayer: null,
  decrypt: false,
  renderView: 'final',
  selectedDomNode: null,
  previousTotalUs: null,
  previousFirstPaintUs: null,
  whatIfOpen: false,
  set: (patch) => set(patch),
  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
}));
