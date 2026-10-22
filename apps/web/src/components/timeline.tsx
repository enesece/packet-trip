import * as Slider from '@radix-ui/react-slider';
import { useMemo, useState } from 'react';
import type { LayerId } from '@packet-trip/engine';
import { useRun } from '../state/use-sim';
import { SPEEDS, useUi } from '../state/ui-store';
import { useFormat } from '../app/format';
import { loadRun, seekTo, stepEvent, togglePlay } from '../app/controller';
import { IconDice, IconList, IconPause, IconPlay, IconStepBack, IconStepForward } from './ui/icons';
import { layerVar } from '../design/layer-colors';
import { ExpertPanel } from './expert-panel';

const STOP_LAYER: Record<string, LayerId> = {
  dns: 'application',
  tcp: 'transport',
  tls: 'security',
  request: 'application',
  response: 'application',
  render: 'browser',
};

/** The scrubbable timeline pinned to the bottom of every screen. */
export function Timeline() {
  const { t, ms } = useFormat();
  const run = useRun();
  const playhead = useUi((s) => s.playheadUs);
  const playing = useUi((s) => s.playing);
  const speed = useUi((s) => s.speed);
  const mode = useUi((s) => s.mode);
  const config = useUi((s) => s.config);
  const set = useUi((s) => s.set);
  const [panel, setPanel] = useState(false);
  const end = run?.endUs ?? 1;

  const ticks = useMemo(() => {
    if (!run) return [];
    return run.events
      .filter(
        (e) => e.kind === 'send' || e.kind === 'paint' || e.kind === 'timeout' || e.kind === 'drop',
      )
      .map((e) => ({ x: e.tUs / end, layer: e.layer, kind: e.kind, key: e.seq }));
  }, [run, end]);

  const newRun = (): void => {
    const seed = Math.floor(Math.random() * 1_000_000) + 1;
    void loadRun({ config: { ...config, seed }, play: true });
  };

  return (
    <div
      role="region"
      aria-label={t('timeline.label')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur"
      style={{ height: 'var(--timeline-h)' }}
    >
      <div className="mx-auto flex h-full max-w-[1320px] items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onClick={() => void stepEvent(-1)}
          aria-label={t('timeline.stepBack')}
          title={t('timeline.stepBack')}
          disabled={!run}
        >
          <IconStepBack />
        </button>
        <button
          type="button"
          className="btn btn-icon btn-primary"
          onClick={togglePlay}
          aria-label={playing ? t('timeline.pause') : t('timeline.play')}
          title={playing ? t('timeline.pause') : t('timeline.play')}
          disabled={!run}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onClick={() => void stepEvent(1)}
          aria-label={t('timeline.stepForward')}
          title={t('timeline.stepForward')}
          disabled={!run}
        >
          <IconStepForward />
        </button>

        <div className="relative mx-1 h-10 min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute inset-x-0 top-0 h-full w-full"
            preserveAspectRatio="none"
            viewBox="0 0 1000 40"
            aria-hidden="true"
          >
            {run?.windows.map((w) => (
              <rect
                key={w.id}
                x={(w.startUs / end) * 1000}
                width={Math.max(1, ((w.endUs - w.startUs) / end) * 1000)}
                y={27}
                height={3}
                fill={layerVar(STOP_LAYER[w.id] ?? 'link')}
                opacity={0.55}
              />
            ))}
            {ticks.map((k) => (
              <line
                key={k.key}
                x1={k.x * 1000}
                x2={k.x * 1000}
                y1={k.kind === 'send' ? 6 : 3}
                y2={k.kind === 'send' ? 14 : 17}
                stroke={k.kind === 'drop' ? 'var(--danger)' : layerVar(k.layer)}
                strokeWidth={k.kind === 'send' ? 1 : 2}
                vectorEffect="non-scaling-stroke"
                opacity={k.x * end <= playhead ? 1 : 0.35}
              />
            ))}
          </svg>
          <Slider.Root
            className="relative flex h-full w-full touch-none select-none items-center"
            min={0}
            max={end}
            step={50}
            value={[playhead]}
            onValueChange={([v]) => {
              if (v !== undefined) seekTo(v);
            }}
            aria-label={t('timeline.scrub')}
            disabled={!run}
          >
            <Slider.Track className="relative mt-4 h-1 grow rounded-full bg-line">
              <Slider.Range className="absolute h-full rounded-full bg-ink" />
            </Slider.Track>
            <Slider.Thumb
              className="mt-4 block h-4 w-4 rounded-full border-2 border-surface bg-ink shadow-[0_0_0_1px_var(--border-strong)]"
              aria-valuetext={`${ms(playhead)} / ${ms(end)}`}
            />
          </Slider.Root>
        </div>

        <div
          className="mono hidden shrink-0 text-[12px] tabular-nums text-muted sm:block"
          aria-live="off"
        >
          <span className="text-ink">{ms(playhead)}</span> / {ms(run?.endUs ?? null)}
        </div>
        <label className="sr-only" htmlFor="pt-speed">
          {t('timeline.speed')}
        </label>
        <select
          id="pt-speed"
          className="mono h-9 shrink-0 rounded-[10px] border border-line-strong bg-surface px-2 text-[12px]"
          value={speed}
          onChange={(e) => set({ speed: Number(e.target.value) })}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        {mode === 'expert' && (
          <>
            <span className="mono hidden shrink-0 text-[12px] text-muted lg:inline">
              {t('timeline.seed')} {config.seed}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-icon shrink-0"
              onClick={newRun}
              aria-label={t('timeline.newRun')}
              title={t('timeline.newRun')}
            >
              <IconDice />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon shrink-0"
              onClick={() => setPanel(true)}
              aria-label={t('expert.open')}
              title={t('expert.open')}
            >
              <IconList />
            </button>
            <ExpertPanel open={panel} onOpenChange={setPanel} />
          </>
        )}
      </div>
    </div>
  );
}
