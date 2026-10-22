import { scaleLinear } from 'd3-scale';
import { useMemo } from 'react';
import type { PacketSummary } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';

export interface SequenceProps {
  readonly packets: readonly PacketSummary[];
  readonly current: number | null;
  readonly nowUs: number;
  readonly serverLabel: string;
  readonly encryptedFromUs: number | null;
  readonly onSelect: (id: number) => void;
}

/** Two lanes; arrows slant to scale with travel time; future packets at 20% opacity. */
export function SequenceDiagram({
  packets,
  current,
  nowUs,
  serverLabel,
  encryptedFromUs,
  onSelect,
}: SequenceProps) {
  const { t, ms, msg } = useFormat();
  const W = 560;
  const L = 130;
  const R = W - 60;
  const top = 66;
  const t0 = packets[0]?.tUs ?? 0;
  const t1 = Math.max(...packets.map((p) => p.arriveUs ?? p.tUs), t0 + 1);
  const pxPerMs = Math.max(2.2, Math.min(7, 900 / ((t1 - t0) / 1000)));
  const H = top + ((t1 - t0) / 1000) * pxPerMs + 40;
  const y = useMemo(
    () =>
      scaleLinear()
        .domain([t0, t1])
        .range([top, H - 40]),
    [t0, t1, H],
  );
  const cur = packets.find((p) => p.id === current);

  // Avoid overlapping labels: only label an arrow if it is far enough from the previous label.
  const labels = useMemo(() => {
    const out = new Set<number>();
    const taken: number[] = [];
    const mid = (p: PacketSummary): number => (y(p.tUs) + y(p.arriveUs ?? p.tUs + 20_000)) / 2;
    const cur = packets.find((p) => p.id === current);
    if (cur) {
      out.add(cur.id);
      taken.push(mid(cur));
    }
    for (const p of packets) {
      if (p.id === current) continue;
      const m = mid(p);
      if (taken.every((t) => Math.abs(t - m) >= 15)) {
        out.add(p.id);
        taken.push(m);
      }
    }
    return out;
  }, [packets, y, current]);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-labelledby="seq-t"
      >
        <title id="seq-t">{t('handshake.seqTitle', { server: serverLabel })}</title>
        <defs>
          {(['transport', 'security', 'application'] as const).map((l) => (
            <marker
              key={l}
              id={`ah-${l}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={layerVar(l)} />
            </marker>
          ))}
        </defs>
        {encryptedFromUs !== null && (
          <g>
            <rect
              x={L}
              y={y(encryptedFromUs)}
              width={R - L}
              height={H - 40 - y(encryptedFromUs)}
              fill="color-mix(in srgb, var(--layer-security) 7%, transparent)"
            />
            <text
              x={R + 8}
              y={y(encryptedFromUs) + 4}
              textAnchor="start"
              fontSize={10.5}
              fontWeight={600}
              fill="var(--layer-security)"
              transform={`rotate(90 ${R + 8} ${y(encryptedFromUs) + 4})`}
            >
              {t('handshake.encryptedBand')}
            </text>
          </g>
        )}
        {[
          { x: L, label: t('handshake.laptop'), sub: '192.168.1.24' },
          { x: R, label: t('handshake.server'), sub: serverLabel },
        ].map((lane) => (
          <g key={lane.x}>
            <rect
              x={lane.x - 72}
              y={8}
              width={144}
              height={42}
              rx={10}
              fill="var(--surface)"
              stroke="var(--border-strong)"
            />
            <text
              x={lane.x}
              y={26}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="var(--ink)"
            >
              {lane.label}
            </text>
            <text
              x={lane.x}
              y={42}
              textAnchor="middle"
              className="mono"
              fontSize={10}
              fill="var(--muted)"
            >
              {lane.sub}
            </text>
            <line x1={lane.x} x2={lane.x} y1={52} y2={H - 30} stroke="var(--border-strong)" />
          </g>
        ))}
        {packets.map((p) => {
          const out = p.direction === 'out';
          const xs = out ? L : R;
          const xe = out ? R : L;
          const ys = y(p.tUs);
          const arrive = p.arriveUs;
          const isCur = p.id === current;
          const future = p.tUs > nowUs && !isCur;
          const layer =
            p.topLayer === 'browser' || p.topLayer === 'network' || p.topLayer === 'link'
              ? 'transport'
              : p.topLayer;
          let x2 = xe;
          let y2 = arrive !== null ? y(arrive) : ys + 20;
          if (arrive === null) {
            x2 = xs + (xe - xs) * 0.45;
          } else if (!isCur && !future && nowUs < arrive && nowUs >= p.tUs) {
            const f = (nowUs - p.tUs) / Math.max(1, arrive - p.tUs);
            x2 = xs + (xe - xs) * f;
            y2 = ys + (y(arrive) - ys) * f;
          }
          const showLabel = labels.has(p.id);
          const lx = (xs + xe) / 2;
          const ly = (ys + (arrive !== null ? y(arrive) : ys + 20)) / 2 - 5;
          return (
            <g
              key={p.id}
              opacity={future ? 0.2 : 1}
              className="cursor-pointer"
              onClick={() => onSelect(p.id)}
            >
              <line x1={xs} y1={ys} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
              <line
                x1={xs}
                y1={ys}
                x2={x2}
                y2={y2}
                stroke={layerVar(layer)}
                strokeWidth={isCur ? 3 : 1.4}
                markerEnd={
                  arrive !== null && (future || nowUs >= arrive || isCur)
                    ? `url(#ah-${layer})`
                    : undefined
                }
              />
              {arrive === null && (
                <text x={x2 + 4} y={y2 + 4} fontSize={13} fontWeight={700} fill="var(--danger)">
                  ✕
                </text>
              )}
              {showLabel && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  fontSize={isCur ? 12 : 11}
                  fontWeight={isCur ? 700 : 500}
                  fill={isCur ? 'var(--ink)' : 'var(--muted)'}
                  className="select-none"
                >
                  {truncate(msg(p.nameMsg) || p.name, 38)}
                </text>
              )}
              {showLabel && (
                <text
                  x={L - 10}
                  y={ys + 4}
                  textAnchor="end"
                  className="mono"
                  fontSize={10}
                  fill="var(--muted)"
                >
                  {ms(p.tUs, 1)}
                </text>
              )}
            </g>
          );
        })}
        {cur && (
          <circle cx={cur.direction === 'out' ? L : R} cy={y(cur.tUs)} r={4} fill="var(--ink)" />
        )}
      </svg>
      <figcaption className="sr-only">
        <ol>
          {packets.map((p) => (
            <li key={p.id}>
              {t('handshake.srArrow', {
                n: p.id,
                name: p.name,
                dir: p.direction === 'out' ? t('dir.out') : t('dir.in'),
                t: ms(p.tUs),
                arrive: ms(p.arriveUs),
              })}
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
