import * as ToggleGroup from '@radix-ui/react-toggle-group';
import * as Toggle from '@radix-ui/react-toggle';
import { useMemo } from 'react';
import { useFormat } from '../app/format';
import { useKeys } from '../hooks/use-keys';
import { useRun, useSimState } from '../state/use-sim';
import { useUi, type RenderView } from '../state/ui-store';
import { loadRun, play, togglePlay } from '../app/controller';
import { ScreenHeader } from '../components/screen-header';
import { PipelineStrip } from '../components/pipeline-strip';
import { DomTree } from '../components/dom-tree';
import { FakeBrowser } from '../components/fake-browser';
import { Waterfall, type WaterfallRow } from '../components/waterfall';
import { IconReplay } from '../components/ui/icons';
import type { LayerId } from '@packet-trip/engine';

const KIND_LAYER: Record<string, LayerId> = {
  document: 'application',
  stylesheet: 'browser',
  script: 'security',
  font: 'transport',
};

const SPACE = { ' ': togglePlay };

export function Render() {
  const { t, ms } = useFormat();
  const run = useRun();
  const state = useSimState();
  const view = useUi((s) => s.renderView);
  const selected = useUi((s) => s.selectedDomNode);
  const config = useUi((s) => s.config);
  const prevFp = useUi((s) => s.previousFirstPaintUs);
  const set = useUi((s) => s.set);
  const render = state?.render ?? null;
  useKeys(SPACE);

  const rows: WaterfallRow[] = useMemo(
    () =>
      (run?.resources ?? []).map((r) => ({
        id: r.url,
        label: r.url === '/' ? 'index.html' : r.url.replace(/^\//, ''),
        sub: r.renderBlocking ? t('render.blocking') : undefined,
        startUs: r.requestUs,
        splitUs: r.firstByteUs,
        endUs: r.doneUs,
        layer: KIND_LAYER[r.kind] ?? 'application',
      })) as WaterfallRow[],
    [run, t],
  );
  const css = run?.resources.find((r) => r.url === '/style.css');
  const html = run?.resources.find((r) => r.url === '/');
  const fp = run?.firstPaintUs ?? null;

  return (
    <div className="space-y-5">
      <ScreenHeader crumb={t('render.crumb')}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            set({ playheadUs: 0 });
            play();
          }}
        >
          <IconReplay /> {t('render.replay')}
        </button>
      </ScreenHeader>

      <PipelineStrip render={render} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
        <section
          className="panel max-h-[340px] overflow-auto p-3 lg:max-h-[640px]"
          aria-labelledby="dom-h"
        >
          <h2 id="dom-h" className="mb-2 px-1 text-[15px] font-semibold">
            {t('render.dom')}
          </h2>
          <DomTree
            root={render?.domTree ?? null}
            selected={selected}
            onSelect={(id) =>
              set({ selectedDomNode: id === selected ? null : id, renderView: 'boxes' })
            }
          />
        </section>

        <section className="min-w-0 space-y-3" aria-labelledby="fb-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="fb-h" className="text-[15px] font-semibold">
              {t('render.browser')}
            </h2>
            <ToggleGroup.Root
              type="single"
              value={view}
              onValueChange={(v) => v && set({ renderView: v as RenderView })}
              aria-label={t('render.view')}
              className="inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-2 p-0.5"
            >
              {(['boxes', 'paint', 'final'] as const).map((v) => (
                <ToggleGroup.Item
                  key={v}
                  value={v}
                  className="h-7 rounded-[7px] px-2.5 text-[13px] font-semibold text-muted data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_0_0_1px_var(--border-strong)]"
                >
                  {t(`render.view.${v}`)}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>
          <FakeBrowser
            render={render}
            host={run?.site.host ?? 'example.com'}
            view={view}
            selected={selected}
          />
          <p className="text-[12px] text-muted">
            {render?.fontLoaded ? t('render.fontSwapped') : t('render.fontFallback')}
          </p>
        </section>

        <aside className="min-w-0 space-y-4">
          <section className="card p-4" aria-labelledby="res-h">
            <h2 id="res-h" className="text-[15px] font-semibold">
              {t('render.arrived')}
            </h2>
            {run && (
              <div className="mt-2">
                <Waterfall
                  title={t('render.arrived')}
                  rows={rows}
                  endUs={run.loadUs ?? run.endUs}
                  labelWidth={140}
                  markers={[
                    ...(fp
                      ? [
                          {
                            id: 'fp',
                            label: t('render.firstPaint'),
                            tUs: fp,
                            color: 'var(--layer-browser)',
                          },
                        ]
                      : []),
                    ...(run.loadUs
                      ? [
                          {
                            id: 'load',
                            label: t('render.load'),
                            tUs: run.loadUs,
                            color: 'var(--ink)',
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            )}
          </section>
          <section
            className="card p-4"
            aria-labelledby="why-h"
            style={{ borderColor: 'color-mix(in srgb, var(--layer-browser) 40%, var(--border))' }}
          >
            <h2 id="why-h" className="text-[15px] font-semibold">
              {t('render.why')}
            </h2>
            <p className="mt-1.5 text-[13px] leading-snug">
              {config.inlineCriticalCss
                ? t('render.whyInline', { html: ms(html?.doneUs ?? null), fp: ms(fp) })
                : t('render.whyText', {
                    html: ms(html?.doneUs ?? null),
                    css: ms(css?.doneUs ?? null),
                    fp: ms(fp),
                  })}
            </p>
            <Toggle.Root
              pressed={config.inlineCriticalCss}
              onPressedChange={(v) =>
                void loadRun({
                  config: { ...config, inlineCriticalCss: v },
                  compare: true,
                  keepTime: true,
                })
              }
              className="btn mt-3"
              aria-label={t('render.inlineToggle')}
            >
              <span
                className={`inline-block h-4 w-7 rounded-full p-0.5 transition-colors ${config.inlineCriticalCss ? 'bg-ink' : 'bg-line-strong'}`}
                aria-hidden="true"
              >
                <span
                  className={`block h-3 w-3 rounded-full bg-surface transition-transform ${config.inlineCriticalCss ? 'translate-x-3' : ''}`}
                />
              </span>
              {t('render.inlineToggle')}
            </Toggle.Root>
            {prevFp !== null && fp !== null && prevFp !== fp && (
              <p
                className="mono mt-2 text-[13px] font-semibold"
                role="status"
                style={{ color: fp < prevFp ? 'var(--success)' : 'var(--danger)' }}
              >
                {t('render.fpDelta', {
                  delta: `${fp < prevFp ? '−' : '+'}${ms(Math.abs(fp - prevFp))}`,
                })}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
