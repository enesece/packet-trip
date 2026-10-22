import type { ScenarioConfig } from '@packet-trip/engine';
import { getSimClient } from '../worker/client';
import { useUi } from '../state/ui-store';

let skipSeek = false;

/** Loads a run for the current (or given) config. */
export async function loadRun(
  opts: { config?: ScenarioConfig; play?: boolean; keepTime?: boolean; compare?: boolean } = {},
): Promise<void> {
  const ui = useUi.getState();
  const client = getSimClient();
  const prevTotal = client.getView().run?.totalUs ?? null;
  const prevFp = client.getView().run?.firstPaintUs ?? null;
  const config = opts.config ?? ui.config;
  if (opts.config) ui.set({ config });
  const run = await client.load(config, ui.crypto);
  if (!run) return;
  const keep = opts.keepTime ? Math.min(useUi.getState().playheadUs, run.endUs) : 0;
  useUi.getState().set({
    previousTotalUs: opts.compare ? prevTotal : null,
    previousFirstPaintUs: opts.compare ? prevFp : null,
    playing: opts.play ?? false,
    playheadUs: keep,
  });
  client.seek(keep);
}

export function seekTo(t: number): void {
  const run = getSimClient().getView().run;
  const end = run?.endUs ?? 0;
  useUi.getState().set({ playheadUs: Math.max(0, Math.min(end, Math.round(t))) });
}

export function play(): void {
  const s = useUi.getState();
  const run = getSimClient().getView().run;
  if (run && s.playheadUs >= run.endUs) s.set({ playheadUs: 0 });
  useUi.getState().set({ playing: true, started: true });
}

export function pause(): void {
  useUi.getState().set({ playing: false });
}

export function togglePlay(): void {
  if (useUi.getState().playing) pause();
  else play();
}

/** Steps one engine event (re-simulating from t = 0 when going back). */
export async function stepEvent(dir: 1 | -1): Promise<void> {
  pause();
  const t = await getSimClient().step(dir);
  if (t === null) return;
  skipSeek = true;
  useUi.getState().set({ playheadUs: t });
}

/** Moves the playhead to the next / previous packet send time (optionally within a filter). */
export function stepPacket(dir: 1 | -1, filter?: (id: number) => boolean): number | null {
  pause();
  const run = getSimClient().getView().run;
  if (!run) return null;
  const now = useUi.getState().playheadUs;
  const list = run.packets.filter((p) => (filter ? filter(p.id) : true));
  const target =
    dir === 1 ? list.find((p) => p.tUs > now) : [...list].reverse().find((p) => p.tUs < now);
  if (!target) return null;
  useUi.getState().set({ playheadUs: target.tUs, selectedPacket: target.id });
  return target.id;
}

/** Wires the playhead to the worker and runs the rAF playback loop. Call once. */
export function startPlaybackEngine(): () => void {
  const client = getSimClient();
  const unsub = useUi.subscribe((s, prev) => {
    if (s.playheadUs !== prev.playheadUs) {
      if (skipSeek) skipSeek = false;
      else client.seek(s.playheadUs);
    }
  });
  let raf = 0;
  let last = 0;
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    const s = useUi.getState();
    if (!s.playing) {
      last = 0;
      return;
    }
    const run = client.getView().run;
    if (!run) return;
    const dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    const from = s.playheadUs;
    let to = from + dt * 1000 * s.speed;
    let stopHere = false;
    if (s.mode === 'story') {
      // Auto-pause at the start of each stop.
      const boundary = run.windows.map((w) => w.startUs).find((b) => b > from && b <= to && b > 0);
      if (boundary !== undefined) {
        to = boundary;
        stopHere = true;
      }
    }
    if (to >= run.endUs) {
      to = run.endUs;
      stopHere = true;
    }
    s.set({ playheadUs: Math.round(to), ...(stopHere ? { playing: false } : {}) });
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    unsub();
  };
}
