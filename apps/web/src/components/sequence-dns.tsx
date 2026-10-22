import { useMemo } from 'react';
import type { NodeId, PacketSummary } from '@packet-trip/engine';
import { useRun } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';

const SERVERS: readonly NodeId[] = ['root', 'tld', 'ns1', 'ns2'];

export function isDnsAnswer(p: PacketSummary): boolean {
  return SERVERS.includes(p.from) || (p.from === 'resolver' && p.to === 'laptop');
}

function arrowLabel(p: PacketSummary): string {
  return p.name.replace(/ → (root|\.\w+|ns1|ns2 \(retry\))$/, '');
}

/** Lanes You / Resolver / Root / .com / ns1 with numbered query (solid) and answer (dashed) arrows. */
export function DnsSequence({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const { t, ms } = useFormat();
  const run = useRun();
  const now = useUi((s) => s.playheadUs);
  const lanes = run?.dnsLanes ?? [];
  const packets = useMemo(() => (run?.packets ?? []).filter((p) => p.flow === 'dns'), [run]);
  const timeouts = useMemo(
    () => (run?.events ?? []).filter((e) => e.kind === 'timeout' && e.node === 'resolver'),
    [run],
  );
  const W = 900;
  const top = 64;
  const rowH = 46;
  const H = top + Math.max(packets.length, 8) * rowH + 16;
  const laneX = (n: NodeId): number => {
    const i = lanes.findIndex((l) => l.node === n);
    return 70 + (i * (W - 140)) / Math.max(1, lanes.length - 1);
  };
  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[640px]"
          role="img"
          aria-labelledby="dnsseq-t"
        >
          <title id="dnsseq-t">{t('dns.seqTitle')}</title>
          <defs>
            <marker
              id="dns-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={layerVar('application')} />
            </marker>
          </defs>
          {lanes.map((l) => (
            <g key={l.node}>
              <rect
                x={laneX(l.node) - 62}
                y={6}
                width={124}
                height={42}
                rx={10}
                fill="var(--surface)"
                stroke="var(--border-strong)"
              />
              <text
                x={laneX(l.node)}
                y={24}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="var(--ink)"
              >
                {l.node === 'laptop'
                  ? t('dns.lane.you')
                  : l.node === 'resolver'
                    ? t('dns.lane.resolver')
                    : l.node === 'root'
                      ? t('dns.lane.root')
                      : l.label}
              </text>
              <text
                x={laneX(l.node)}
                y={40}
                textAnchor="middle"
                className="mono"
                fontSize={10}
                fill="var(--muted)"
              >
                {l.address}
              </text>
              <line
                x1={laneX(l.node)}
                x2={laneX(l.node)}
                y1={50}
                y2={H - 6}
                stroke="var(--border-strong)"
                strokeDasharray="2 4"
              />
            </g>
          ))}
          {packets.every((p) => p.tUs > now) && (
            <text x={W / 2} y={top + 60} textAnchor="middle" fontSize={13} fill="var(--muted)">
              {t('dns.pressPlay')}
            </text>
          )}
          {packets.map((p, i) => {
            if (p.tUs > now) return null;
            const y = top + i * rowH + 20;
            const x1 = laneX(p.from);
            const x2 = laneX(p.to);
            const arrive = p.arriveUs ?? p.tUs;
            const f = arrive > p.tUs ? Math.min(1, (now - p.tUs) / (arrive - p.tUs)) : 1;
            const xe = x1 + (x2 - x1) * f;
            const answer = isDnsAnswer(p);
            const sel = selected === p.id;
            const dropped = p.to === 'ns1' && timeouts.length > 0;
            const mid = (x1 + x2) / 2;
            return (
              <g
                key={p.id}
                className="cursor-pointer"
                onClick={() => onSelect(p.id)}
                role="button"
                tabIndex={0}
                aria-label={`${p.dnsStep ?? ''}. ${arrowLabel(p)}`}
                onKeyDown={(e) =>
                  (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p.id))
                }
              >
                <rect
                  x={Math.min(x1, x2)}
                  y={y - 22}
                  width={Math.abs(x2 - x1)}
                  height={32}
                  fill="transparent"
                />
                <line
                  x1={x1}
                  y1={y}
                  x2={xe}
                  y2={y}
                  stroke={layerVar('application')}
                  strokeWidth={sel ? 3 : 1.75}
                  strokeDasharray={answer ? '7 5' : undefined}
                  markerEnd={f >= 1 ? 'url(#dns-arrow)' : undefined}
                />
                <circle
                  cx={x1 + (x2 > x1 ? 14 : -14)}
                  cy={y}
                  r={10}
                  fill={sel ? layerVar('application') : 'var(--surface)'}
                  stroke={layerVar('application')}
                />
                <text
                  x={x1 + (x2 > x1 ? 14 : -14)}
                  y={y + 4}
                  textAnchor="middle"
                  className="mono"
                  fontSize={11}
                  fontWeight={700}
                  fill={sel ? 'var(--tag-fg)' : layerVar('application')}
                >
                  {p.dnsStep}
                </text>
                <text
                  x={mid}
                  y={y - 8}
                  textAnchor="middle"
                  className="mono"
                  fontSize={12}
                  fill="var(--ink)"
                  fontWeight={sel ? 700 : 500}
                >
                  {arrowLabel(p)}
                </text>
                <text
                  x={Math.max(x1, x2) + 8}
                  y={y + 4}
                  className="mono"
                  fontSize={10}
                  fill="var(--muted)"
                >
                  {ms(p.tUs, 1)}
                </text>
                {dropped && now >= arrive && (
                  <text x={x2 + 10} y={y - 6} fontSize={12} fill="var(--danger)" fontWeight={700}>
                    {t('dns.noAnswer')}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="sr-only">
        <ol>
          {packets
            .filter((p) => p.tUs <= now)
            .map((p) => (
              <li key={p.id}>
                {t('dns.srStep', {
                  n: p.dnsStep ?? 0,
                  from: t(`node.${p.from}`),
                  to: t(`node.${p.to}`),
                  label: arrowLabel(p),
                  kind: isDnsAnswer(p) ? t('dns.answer') : t('dns.query'),
                })}
              </li>
            ))}
        </ol>
      </figcaption>
    </figure>
  );
}
