import * as Toggle from '@radix-ui/react-toggle';
import { useNavigate, useLocation } from 'react-router';
import { useFormat } from '../app/format';
import { useKeys } from '../hooks/use-keys';
import { useRun, useSimState } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { loadRun, togglePlay } from '../app/controller';
import { ScreenHeader } from '../components/screen-header';
import { DnsSequence, isDnsAnswer } from '../components/sequence-dns';
import { PacketInspector } from '../components/packet-inspector';
import { usePacket } from '../hooks/use-packet';
import { IconArrowRight } from '../components/ui/icons';
import { Segmented } from '../app/layout/header';
import type { DnsWarmth } from '@packet-trip/engine';

const SPACE = { ' ': togglePlay };

export function Dns() {
  const { t, ms, msg } = useFormat();
  const run = useRun();
  const state = useSimState();
  const now = useUi((s) => s.playheadUs);
  const selected = useUi((s) => s.selectedPacket);
  const config = useUi((s) => s.config);
  const set = useUi((s) => s.set);
  const navigate = useNavigate();
  const loc = useLocation();
  useKeys(SPACE);

  const dnsPackets = run?.packets.filter((p) => p.flow === 'dns') ?? [];
  const sent = dnsPackets.filter((p) => p.tUs <= now);
  const effective = dnsPackets.some((p) => p.id === selected)
    ? selected
    : (sent[sent.length - 1]?.id ?? dnsPackets[0]?.id ?? null);
  const detail = usePacket(effective);
  const host = run?.site.host ?? config.site;

  const cacheEvents = (run?.events ?? []).filter(
    (e) => e.kind === 'cache' && e.node === 'laptop' && /ev\.cache\.(browser|os)\./.test(e.msg.key),
  );
  const tcpStart = run?.windows.find((w) => w.id === 'tcp')?.startUs ?? 0;

  const rerun = (patch: Partial<typeof config>): void => {
    set({ selectedPacket: null, started: true });
    void loadRun({ config: { ...config, ...patch }, play: true, compare: true });
  };

  return (
    <div className="space-y-6">
      <ScreenHeader crumb={t('dns.crumb')}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            set({ playheadUs: tcpStart, playing: false });
            void navigate({ pathname: '/handshake', search: loc.search });
          }}
        >
          {t('dns.next')} <IconArrowRight />
        </button>
      </ScreenHeader>

      <section aria-labelledby="dns-h">
        <h1 id="dns-h" className="text-[28px] font-semibold leading-tight sm:text-[34px]">
          {t('dns.headline', { host })}
        </h1>
        <p className="mt-2 max-w-[760px] text-[15px] text-muted">{t('dns.explain')}</p>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="panel p-4 sm:p-5" aria-labelledby="dns-seq-h">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="dns-seq-h" className="text-[16px] font-semibold">
              {t('dns.seqHeading')}
            </h2>
            <p className="flex items-center gap-4 text-[12px] text-muted">
              <span className="flex items-center gap-1.5">
                <svg width="26" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="26"
                    y2="3"
                    stroke="var(--layer-application)"
                    strokeWidth="2"
                  />
                </svg>
                {t('dns.query')}
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="26" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="26"
                    y2="3"
                    stroke="var(--layer-application)"
                    strokeWidth="2"
                    strokeDasharray="6 4"
                  />
                </svg>
                {t('dns.answer')}
              </span>
            </p>
          </div>
          {dnsPackets.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-muted">{t('dns.noPackets')}</p>
          ) : (
            <DnsSequence selected={effective} onSelect={(id) => set({ selectedPacket: id })} />
          )}
        </section>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <section className="card p-4" aria-labelledby="dns-first">
            <h3 id="dns-first" className="text-[15px] font-semibold">
              {t('dns.card.first')}
            </h3>
            <ul className="mt-2 space-y-1.5 text-[13px]">
              {cacheEvents.map((e) => (
                <li key={e.seq} className={e.tUs > now ? 'text-muted opacity-60' : ''}>
                  <span className="mono mr-2 text-[11px] text-muted">{ms(e.tUs, 2)}</span>
                  {msg(e.msg)}
                </li>
              ))}
            </ul>
            {(state?.dnsCache.length ?? 0) > 0 && (
              <p className="mt-2 text-[12px] text-muted">
                {t('dns.cacheCount', { count: state?.dnsCache.length ?? 0 })}
              </p>
            )}
          </section>
          <section className="card p-4" aria-labelledby="dns-try">
            <h3 id="dns-try" className="text-[15px] font-semibold">
              {t('dns.card.try')}
            </h3>
            <p className="mt-1 text-[13px] text-muted">{t('dns.card.tryText')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => rerun({ warmDnsCache: 'browser' })}
              >
                {t('dns.enterAgain')}
              </button>
            </div>
            <div className="mt-3">
              <Segmented<DnsWarmth>
                label={t('dns.warmth')}
                value={config.warmDnsCache}
                onChange={(v) => rerun({ warmDnsCache: v })}
                items={[
                  { value: 'cold', label: t('dns.warm.cold') },
                  { value: 'resolver', label: t('dns.warm.resolver') },
                  { value: 'browser', label: t('dns.warm.browser') },
                ]}
              />
            </div>
          </section>
          <section className="card p-4" aria-labelledby="dns-break">
            <h3 id="dns-break" className="text-[15px] font-semibold">
              {t('dns.card.break')}
            </h3>
            <p className="mt-1 text-[13px] text-muted">{t('dns.card.breakText')}</p>
            <Toggle.Root
              pressed={config.ns1Timeout}
              onPressedChange={(v) => rerun({ ns1Timeout: v })}
              className="btn mt-3 data-[state=on]:border-danger data-[state=on]:text-danger"
              aria-label={t('dns.ns1Toggle')}
            >
              <span
                className={`inline-block h-4 w-7 rounded-full p-0.5 transition-colors ${config.ns1Timeout ? 'bg-danger' : 'bg-line-strong'}`}
                aria-hidden="true"
              >
                <span
                  className={`block h-3 w-3 rounded-full bg-surface transition-transform ${config.ns1Timeout ? 'translate-x-3' : ''}`}
                />
              </span>
              {t('dns.ns1Toggle')}
            </Toggle.Root>
          </section>
        </div>
      </div>

      <PacketInspector
        detail={detail}
        titleKey={
          detail && isDnsAnswer(detail.summary) ? 'dns.inspector.response' : 'dns.inspector.query'
        }
      />
    </div>
  );
}
