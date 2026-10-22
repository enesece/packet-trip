import { useMemo } from 'react';
import { useFormat } from '../app/format';
import { useRun, useSimState } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { AddressBar } from '../components/address-bar';
import { StopCard } from '../components/stop-card';
import { NetworkMap } from '../components/network-map';
import { Waterfall, type WaterfallRow } from '../components/waterfall';
import { Legend } from '../components/legend';
import { STOP_META } from '../app/stops';

export function Journey() {
  const { t, ms } = useFormat();
  const run = useRun();
  const state = useSimState();
  const now = useUi((s) => s.playheadUs);
  const stops = state?.stops ?? [];

  const rows: WaterfallRow[] = useMemo(
    () =>
      (run?.windows ?? []).map((w) => ({
        id: w.id,
        label: t(`stop.${w.id}.short`),
        startUs: w.startUs,
        endUs: w.endUs,
        layer: STOP_META[w.id].layer,
      })),
    [run, t],
  );

  return (
    <div className="space-y-8">
      <section aria-labelledby="hero-title" className="pt-2">
        <h1
          id="hero-title"
          className="max-w-[900px] text-[30px] font-semibold leading-[1.12] tracking-[-0.01em] sm:text-[42px]"
        >
          {t('journey.headline', {
            ms: run?.marks.firstPaintUs ? Math.round(run.marks.firstPaintUs / 1000) : 200,
          })}
        </h1>
        <p className="mt-3 max-w-[720px] text-[16px] text-muted">{t('journey.sub')}</p>
        <div className="mt-6 max-w-[900px]">
          <AddressBar />
        </div>
      </section>

      <section aria-labelledby="stops-title">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="stops-title" className="text-[18px] font-semibold">
            {t('journey.sixStops')}
          </h2>
          <p className="mono text-[12px] text-muted">
            {t('journey.total')} <span className="text-ink">{ms(run?.totalUs ?? null)}</span>
          </p>
        </div>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {stops.map((s) => (
            <li key={s.id}>
              <StopCard stop={s} nowUs={now} />
            </li>
          ))}
        </ol>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="panel p-4 sm:p-5" id="map" aria-labelledby="map-h">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 id="map-h" className="text-[16px] font-semibold">
              {t('map.heading')}
            </h2>
            <p className="text-[12px] text-muted">{t('map.hint')}</p>
          </div>
          <NetworkMap />
        </section>
        <div className="space-y-4">
          <section className="card p-5" aria-labelledby="wf-title">
            <h2 id="wf-title" className="text-[16px] font-semibold">
              {t('waterfall.title')}
            </h2>
            <p className="mb-3 mt-1 text-[13px] text-muted">{t('waterfall.sub')}</p>
            {run && (
              <Waterfall
                title={t('waterfall.title')}
                rows={rows}
                endUs={run.loadUs ?? run.endUs}
                markers={
                  run.firstPaintUs
                    ? [
                        {
                          id: 'fp',
                          label: t('render.firstPaint'),
                          tUs: run.firstPaintUs,
                          color: 'var(--layer-browser)',
                        },
                      ]
                    : []
                }
              />
            )}
          </section>
          <Legend />
        </div>
      </div>
    </div>
  );
}
