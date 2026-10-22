import type { Stop } from '@packet-trip/engine';
import { useNavigate, useLocation } from 'react-router';
import { useFormat } from '../app/format';
import { STOP_META } from '../app/stops';
import { layerVar } from '../design/layer-colors';
import { LayerTag } from './ui/layer-tag';
import { useUi } from '../state/ui-store';

export function StopCard({ stop, nowUs }: { stop: Stop; nowUs: number }) {
  const { t, ms } = useFormat();
  const navigate = useNavigate();
  const loc = useLocation();
  const meta = STOP_META[stop.id];
  const duration =
    stop.state === 'done'
      ? stop.endUs - stop.startUs
      : stop.state === 'current'
        ? Math.max(0, nowUs - stop.startUs)
        : null;
  const stateCls =
    stop.state === 'current'
      ? 'state-current bg-surface'
      : stop.state === 'done'
        ? 'state-done bg-surface'
        : 'state-future';
  return (
    <button
      type="button"
      onClick={() => {
        useUi.getState().set({ playheadUs: stop.startUs, playing: false });
        void navigate({ pathname: meta.route, search: loc.search });
      }}
      className={`flex h-full w-full flex-col rounded-[14px] p-4 text-left transition-colors ${stateCls}`}
      style={stop.state === 'current' ? { borderColor: layerVar(meta.layer) } : undefined}
      aria-current={stop.state === 'current' ? 'step' : undefined}
      aria-label={`${t('stops.stop', { n: meta.n })}: ${t(`stop.${stop.id}.title`)} — ${t(`stops.state.${stop.state}`)}`}
    >
      <div className="flex items-center justify-between gap-2">
        <LayerTag layer={meta.layer}>{t(`layer.${meta.layer}`).toUpperCase()}</LayerTag>
        <span className="mono text-[12px] text-muted">{String(meta.n).padStart(2, '0')}</span>
      </div>
      <h3
        className={`mt-3 text-[17px] font-semibold ${stop.state === 'future' ? 'text-muted' : ''}`}
      >
        {t(`stop.${stop.id}.title`)}
      </h3>
      <p className="mt-1 flex-1 text-[13px] leading-snug text-muted">{t(`stop.${stop.id}.desc`)}</p>
      <p
        className="mono mt-3 text-[13px] tabular-nums"
        style={{ color: stop.state === 'future' ? 'var(--muted)' : layerVar(meta.layer) }}
      >
        {duration === null ? '—' : ms(duration)}
      </p>
    </button>
  );
}
