import * as Toggle from '@radix-ui/react-toggle';
import { useMemo } from 'react';
import { useFormat } from '../app/format';
import { useRun } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { stepPacket, togglePlay } from '../app/controller';
import { ScreenHeader } from '../components/screen-header';
import { PacketList } from '../components/packet-list';
import { SequenceDiagram } from '../components/sequence-diagram';
import { InsidePacket } from '../components/inside-packet';
import { WhatIfDrawer } from '../components/what-if-drawer';
import { usePacket } from '../hooks/use-packet';
import { useRealDecrypt } from '../hooks/use-real-decrypt';
import { useKeys } from '../hooks/use-keys';
import { IconArrowLeft, IconArrowRight, IconKey, IconSliders } from '../components/ui/icons';
import { layerVar } from '../design/layer-colors';

export function Handshake() {
  const { t, ms, msg, bytes } = useFormat();
  const run = useRun();
  const now = useUi((s) => s.playheadUs);
  const selected = useUi((s) => s.selectedPacket);
  const decrypt = useUi((s) => s.decrypt);
  const mode = useUi((s) => s.mode);
  const set = useUi((s) => s.set);
  const expert = mode === 'expert';

  const packets = useMemo(() => (run?.packets ?? []).filter((p) => p.connId === 1), [run]);
  const ids = useMemo(() => new Set(packets.map((p) => p.id)), [packets]);
  const sent = packets.filter((p) => p.tUs <= now);
  const current =
    selected !== null && ids.has(selected)
      ? selected
      : (sent[sent.length - 1]?.id ?? packets[0]?.id ?? null);
  const detail = usePacket(current);
  const real = useRealDecrypt(detail, decrypt);
  const cur = packets.find((p) => p.id === current) ?? null;
  const encryptedFrom = packets.find((p) => p.encrypted)?.tUs ?? null;
  const select = (id: number): void => {
    const p = packets.find((x) => x.id === id);
    if (p) set({ selectedPacket: id, playheadUs: p.tUs, playing: false });
  };
  const next = (): void => {
    const i = packets.findIndex((p) => p.id === current);
    const p = packets[i + 1];
    if (p) select(p.id);
    else stepPacket(1, (id) => ids.has(id));
  };
  const prev = (): void => {
    const i = packets.findIndex((p) => p.id === current);
    const p = packets[i - 1];
    if (p) select(p.id);
  };
  useKeys({ ArrowRight: next, ArrowLeft: prev, ' ': togglePlay });

  const server = run ? `${run.site.serverAddress}:443` : '203.0.113.10:443';

  return (
    <div className="space-y-5">
      <ScreenHeader crumb={t('handshake.crumb')}>
        <button type="button" className="btn" onClick={() => set({ whatIfOpen: true })}>
          <IconSliders /> {t('whatif.open')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={prev}
          disabled={!cur || packets[0]?.id === cur.id}
          aria-keyshortcuts="ArrowLeft"
        >
          <IconArrowLeft /> {t('handshake.prev')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={next}
          disabled={!cur || packets[packets.length - 1]?.id === cur.id}
          aria-keyshortcuts="ArrowRight"
        >
          {t('handshake.next')} <IconArrowRight />
        </button>
      </ScreenHeader>
      <p className="text-[13px] text-muted">{t('handshake.keys')}</p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_380px]">
        <section
          className="panel p-3 lg:max-h-[calc(100dvh-220px)] lg:overflow-auto"
          aria-labelledby="pl-h"
        >
          <h2 id="pl-h" className="mb-2 px-1 text-[15px] font-semibold">
            {t('handshake.captured', { count: packets.length })}
          </h2>
          <div className="max-h-[340px] overflow-auto lg:max-h-none lg:overflow-visible">
            <PacketList
              packets={packets}
              current={current}
              onSelect={select}
              label={t('handshake.captured', { count: packets.length })}
            />
          </div>
          <div className="card mt-3 p-3 text-[13px] leading-snug text-muted">
            <p className="font-semibold text-ink">{t('handshake.rttTitle')}</p>
            <p className="mt-1">
              {t('handshake.rttNote', { rtt: Math.round((run?.config.rttScale ?? 1) * 24) })}
            </p>
          </div>
        </section>

        <section className="panel min-w-0 p-3 sm:p-4" aria-labelledby="seq-h">
          <h2 id="seq-h" className="sr-only">
            {t('handshake.seqHeading')}
          </h2>
          <SequenceDiagram
            packets={packets}
            current={current}
            nowUs={now}
            serverLabel={server}
            encryptedFromUs={encryptedFrom}
            onSelect={select}
          />
        </section>

        <section className="panel min-w-0 p-4" aria-labelledby="pd-h" aria-live="polite">
          {cur && detail ? (
            <>
              <p className="mono text-[12px] text-muted">
                {t('handshake.packetN', { n: cur.id })} ·{' '}
                {cur.direction === 'out' ? t('dir.outShort') : t('dir.inShort')} · {bytes(cur.size)}{' '}
                · {ms(cur.tUs)}
              </p>
              <h2 id="pd-h" className="mt-1 text-[18px] font-semibold leading-snug">
                {msg(cur.nameMsg) || cur.name}
              </h2>
              <p className="mt-1.5 text-[14px] leading-snug">{msg(cur.story)}</p>
              {cur.lost && (
                <p className="mt-1.5 text-[13px] font-semibold text-danger">
                  {t('handshake.lostNote')}
                </p>
              )}
              <div className="mt-4 flex items-center justify-between gap-2">
                <h3 className="text-[14px] font-semibold">{t('handshake.inside')}</h3>
                {detail.decrypted.length > 0 && (
                  <Toggle.Root
                    pressed={decrypt}
                    onPressedChange={(v) => set({ decrypt: v })}
                    className="btn h-8 px-2.5 text-[13px] data-[state=on]:text-[var(--layer-security)] data-[state=on]:shadow-[inset_0_0_0_1.5px_var(--layer-security)]"
                    aria-label={t('decrypt.toggle')}
                  >
                    <IconKey size={15} /> {t('decrypt.toggle')}
                  </Toggle.Root>
                )}
              </div>
              <div className="mt-2">
                <InsidePacket detail={detail} expert={expert} decrypt={decrypt} real={real} />
              </div>
            </>
          ) : (
            <p className="text-[14px] text-muted">{t('inspector.empty')}</p>
          )}
        </section>
      </div>

      <nav
        aria-label={t('handshake.progress')}
        aria-hidden="true"
        className="flex flex-wrap items-center gap-1"
      >
        {packets.map((p) => {
          const isCur = p.id === current;
          return (
            <button
              key={p.id}
              type="button"
              tabIndex={-1}
              onClick={() => select(p.id)}
              aria-label={t('handshake.dot', { n: p.id, name: p.name })}
              aria-current={isCur ? 'step' : undefined}
              className="h-2.5 rounded-full p-0 transition-all"
              style={{
                width: isCur ? 26 : 10,
                background: layerVar(p.topLayer),
                opacity: p.tUs <= now ? 1 : 0.3,
              }}
            />
          );
        })}
      </nav>
      <WhatIfDrawer />
    </div>
  );
}
