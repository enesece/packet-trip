import type { PipelineStep, RenderState } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';

const STEPS: readonly PipelineStep[] = ['html', 'css', 'style', 'layout', 'paint', 'composite'];

export function PipelineStrip({ render }: { render: RenderState | null }) {
  const { t, ms } = useFormat();
  return (
    <ol
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      aria-label={t('render.pipeline')}
    >
      {STEPS.map((s, i) => {
        const st = render?.pipeline[s] ?? 'future';
        const cls =
          st === 'current'
            ? 'state-current bg-surface'
            : st === 'done'
              ? 'state-done bg-surface'
              : 'state-future';
        const time = render?.pipelineTimes[s] ?? null;
        return (
          <li
            key={s}
            className={`rounded-[12px] px-3 py-2.5 ${cls}`}
            style={st === 'current' ? { borderColor: layerVar('browser') } : undefined}
            aria-current={st === 'current' ? 'step' : undefined}
          >
            <p className="mono text-[11px] text-muted">
              {String(i + 1).padStart(2, '0')} · {t(`render.state.${st}`)}
            </p>
            <p
              className={`mt-0.5 text-[14px] font-semibold ${st === 'future' ? 'text-muted' : ''}`}
            >
              {t(`render.step.${s}`)}
            </p>
            <p className="text-[12px] text-muted">{t(`render.step.${s}.out`)}</p>
            {st === 'done' && time !== null && (
              <p className="mono mt-1 text-[11px]" style={{ color: layerVar('browser') }}>
                {ms(time)}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
