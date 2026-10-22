import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SelfTestResult } from '@packet-trip/engine';
import { useRun, useSim } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { useFormat } from '../app/format';
import { getSimClient } from '../worker/client';
import { IconCheck, IconX } from './ui/icons';
import { LayerTag } from './ui/layer-tag';
import { KeySchedulePanel } from './key-schedule';

export function ExpertPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useFormat();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="panel fixed inset-y-3 right-3 z-50 flex w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <Dialog.Title className="text-[16px] font-semibold">{t('expert.title')}</Dialog.Title>
            <Dialog.Close className="btn btn-ghost btn-icon" aria-label={t('common.close')}>
              <IconX />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t('expert.description')}</Dialog.Description>
          <Tabs.Root defaultValue="log" className="flex min-h-0 flex-1 flex-col">
            <Tabs.List
              className="flex gap-1 border-b border-line px-4 pt-2"
              aria-label={t('expert.title')}
            >
              {(['log', 'checks', 'keys'] as const).map((k) => (
                <Tabs.Trigger
                  key={k}
                  value={k}
                  className="rounded-t-lg px-3 py-2 text-[14px] font-semibold text-muted data-[state=active]:text-ink data-[state=active]:shadow-[inset_0_-2px_0_var(--ink)]"
                >
                  {t(`expert.tab.${k}`)}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="log" className="min-h-0 flex-1 overflow-auto">
              <EventLog />
            </Tabs.Content>
            <Tabs.Content value="checks" className="min-h-0 flex-1 overflow-auto p-5">
              <SelfTestPanel />
            </Tabs.Content>
            <Tabs.Content value="keys" className="min-h-0 flex-1 overflow-auto p-5">
              <KeySchedulePanel />
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EventLog() {
  const { ms, msg, t } = useFormat();
  const run = useRun();
  const cursor = useSim((v) => v.state?.cursor ?? -1);
  const set = useUi((s) => s.set);
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center' });
  }, [cursor]);
  const events = run?.events ?? [];
  return (
    <ol className="mono divide-y divide-line text-[12px]" aria-label={t('expert.tab.log')}>
      {events.map((e) => (
        <li
          key={e.seq}
          ref={e.seq === cursor ? ref : undefined}
          className={`flex gap-3 px-4 py-1.5 ${e.seq > cursor ? 'opacity-40' : ''} ${e.seq === cursor ? 'bg-surface-2' : ''}`}
        >
          <span className="w-[74px] shrink-0 tabular-nums text-muted">{ms(e.tUs, 2)}</span>
          <span className="w-[64px] shrink-0">
            <LayerTag layer={e.layer}>{e.kind}</LayerTag>
          </span>
          {e.packetId !== null ? (
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => set({ selectedPacket: e.packetId, playheadUs: e.tUs })}
            >
              {msg(e.msg)}
            </button>
          ) : (
            <span>{msg(e.msg)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

export function SelfTestPanel() {
  const { t, msg } = useFormat();
  const runId = useSim((v) => v.runId);
  const [results, setResults] = useState<SelfTestResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setResults(null);
  }, [runId]);
  const run = async (): Promise<void> => {
    setBusy(true);
    setResults(await getSimClient().selfTest());
    setBusy(false);
  };
  const passed = useMemo(() => results?.filter((r) => r.pass).length ?? 0, [results]);
  return (
    <div>
      <p className="mb-4 text-[14px] text-muted">{t('checks.intro')}</p>
      <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
        {busy ? t('checks.running') : t('checks.run')}
      </button>
      {results && (
        <>
          <p className="mt-4 text-[14px] font-semibold" role="status">
            {t('checks.summary', { passed, total: results.length })}
          </p>
          <ul className="mt-3 space-y-2">
            {results.map((r) => (
              <li key={r.id} className="card flex items-start gap-3 p-3">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${r.pass ? 'bg-success text-[var(--tag-fg)]' : 'bg-danger text-[var(--tag-fg)]'}`}
                >
                  {r.pass ? <IconCheck size={13} /> : <IconX size={13} />}
                  <span className="sr-only">{r.pass ? t('checks.pass') : t('checks.fail')}</span>
                </span>
                <span>
                  <span className="block text-[14px] font-semibold">
                    {t(`checks.name.${r.id}`)}
                  </span>
                  <span className="block text-[13px] text-muted">{msg(r.detail)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
