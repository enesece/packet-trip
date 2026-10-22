import * as Dialog from '@radix-ui/react-dialog';
import * as Slider from '@radix-ui/react-slider';
import * as Toggle from '@radix-ui/react-toggle';
import { useEffect, useState } from 'react';
import { BASE_RTT_MS } from '../app/constants';
import { useFormat } from '../app/format';
import { loadRun } from '../app/controller';
import { useUi } from '../state/ui-store';
import { useRun } from '../state/use-sim';
import { Segmented } from '../app/layout/header';
import { IconX } from './ui/icons';
import type { ScenarioConfig } from '@packet-trip/engine';

function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => {
    setV(value);
  }, [value]);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label id={`${id}-l`} className="text-[14px] font-semibold">
          {label}
        </label>
        <span className="mono text-[13px] tabular-nums">{format(v)}</span>
      </div>
      <Slider.Root
        className="relative mt-2 flex h-6 w-full touch-none select-none items-center"
        min={min}
        max={max}
        step={step}
        value={[v]}
        onValueChange={([x]) => x !== undefined && setV(x)}
        onValueCommit={([x]) => x !== undefined && onCommit(x)}
        aria-labelledby={`${id}-l`}
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-line">
          <Slider.Range className="absolute h-full rounded-full bg-ink" />
        </Slider.Track>
        <Slider.Thumb
          className="block h-4 w-4 rounded-full border-2 border-surface bg-ink shadow-[0_0_0_1px_var(--border-strong)]"
          aria-valuetext={format(v)}
          aria-labelledby={`${id}-l`}
        />
      </Slider.Root>
    </div>
  );
}

/** What-if: change the network or protocols and see the new total next to the old one. */
export function WhatIfDrawer() {
  const { t, ms, lng } = useFormat();
  const open = useUi((s) => s.whatIfOpen);
  const config = useUi((s) => s.config);
  const prev = useUi((s) => s.previousTotalUs);
  const set = useUi((s) => s.set);
  const run = useRun();
  const apply = (patch: Partial<ScenarioConfig>): void => {
    void loadRun({ config: { ...config, ...patch }, compare: true, keepTime: true });
  };
  const total = run?.totalUs ?? null;
  const delta = prev !== null && total !== null ? total - prev : null;
  const pct = new Intl.NumberFormat(lng, { maximumFractionDigits: 1 });
  return (
    <Dialog.Root open={open} onOpenChange={(o) => set({ whatIfOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content className="panel fixed inset-y-3 right-3 z-50 flex w-[min(400px,calc(100vw-24px))] flex-col overflow-auto p-5 shadow-xl">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-[18px] font-semibold">{t('whatif.title')}</Dialog.Title>
            <Dialog.Close className="btn btn-ghost btn-icon" aria-label={t('common.close')}>
              <IconX />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-[13px] text-muted">
            {t('whatif.sub')}
          </Dialog.Description>

          <div
            className="card mt-4 flex items-baseline justify-between p-4"
            role="status"
            aria-live="polite"
          >
            <div>
              <p className="eyebrow">{t('whatif.total')}</p>
              <p className="mono mt-1 text-[22px] font-semibold tabular-nums">{ms(total, 0)}</p>
            </div>
            {delta !== null && delta !== 0 && (
              <p
                className="mono text-[16px] font-semibold tabular-nums"
                style={{ color: delta > 0 ? 'var(--danger)' : 'var(--success)' }}
              >
                {delta > 0 ? '+' : '−'}
                {ms(Math.abs(delta), 0)}
              </p>
            )}
          </div>
          {prev !== null && (
            <p className="mt-1 text-[12px] text-muted">{t('whatif.was', { ms: ms(prev, 0) })}</p>
          )}

          <div className="mt-6 space-y-6">
            <SliderRow
              id="wi-rtt"
              label={t('whatif.rtt')}
              value={Math.round(config.rttScale * BASE_RTT_MS)}
              min={5}
              max={150}
              step={1}
              format={(v) => `${v} ms`}
              onCommit={(v) => apply({ rttScale: v / BASE_RTT_MS })}
            />
            <SliderRow
              id="wi-loss"
              label={t('whatif.loss')}
              value={Math.round(config.lossRate * 1000) / 10}
              min={0}
              max={10}
              step={0.5}
              format={(v) => `${pct.format(v)} %`}
              onCommit={(v) => apply({ lossRate: v / 100 })}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-semibold" id="wi-tls">
                {t('whatif.tls')}
              </span>
              <Segmented<'1.2' | '1.3'>
                label={t('whatif.tls')}
                value={config.tlsVersion}
                onChange={(v) => apply({ tlsVersion: v })}
                items={[
                  { value: '1.2', label: 'TLS 1.2' },
                  { value: '1.3', label: 'TLS 1.3' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-semibold">{t('whatif.http')}</span>
              <Segmented<'1.1' | '2'>
                label={t('whatif.http')}
                value={config.httpVersion}
                onChange={(v) => apply({ httpVersion: v })}
                items={[
                  { value: '1.1', label: 'HTTP/1.1' },
                  { value: '2', label: 'HTTP/2' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-semibold">{t('whatif.cdn')}</span>
              <Toggle.Root
                pressed={config.cdn}
                onPressedChange={(v) => apply({ cdn: v })}
                className="btn"
                aria-label={t('whatif.cdn')}
              >
                <span
                  className={`inline-block h-4 w-7 rounded-full p-0.5 transition-colors ${config.cdn ? 'bg-ink' : 'bg-line-strong'}`}
                  aria-hidden="true"
                >
                  <span
                    className={`block h-3 w-3 rounded-full bg-surface transition-transform ${config.cdn ? 'translate-x-3' : ''}`}
                  />
                </span>
                {config.cdn ? t('common.on') : t('common.off')}
              </Toggle.Root>
            </div>
            {config.httpVersion === '2' && (
              <p className="text-[12px] text-muted">{t('whatif.h2note')}</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
