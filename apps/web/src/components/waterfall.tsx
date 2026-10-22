import { scaleLinear } from 'd3-scale';
import { useMemo } from 'react';
import type { LayerId } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { useWidth } from '../hooks/use-width';
import { layerVar } from '../design/layer-colors';
import { useUi } from '../state/ui-store';

export interface WaterfallRow {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly layer: LayerId;
  /** Optional inner segment (e.g. waiting vs. downloading). */
  readonly splitUs?: number;
  readonly state?: 'done' | 'current' | 'future';
}

export interface WaterfallMarker {
  readonly id: string;
  readonly label: string;
  readonly tUs: number;
  readonly color: string;
}

/** Horizontal bars on a shared 0 → end ms axis, with a live cursor at the playhead. */
export function Waterfall({
  rows,
  endUs,
  markers = [],
  title,
  labelWidth: labelWidthProp = 120,
}: {
  rows: readonly WaterfallRow[];
  endUs: number;
  markers?: readonly WaterfallMarker[];
  title: string;
  labelWidth?: number;
}) {
  const { ms, t } = useFormat();
  const now = useUi((s) => s.playheadUs);
  const [wrapRef, W] = useWidth<HTMLElement>(640);
  const labelWidth = Math.min(labelWidthProp, Math.round(W * 0.32));
  const hasSub = rows.some((r) => r.sub);
  const rowH = hasSub ? 34 : 30;
  const top = 22;
  const markerRows = markers.length > 1 ? 2 : markers.length;
  const H = top + rows.length * rowH + 8 + markerRows * 13;
  const x = useMemo(
    () =>
      scaleLinear()
        .domain([0, Math.max(1, endUs)])
        .range([labelWidth, W - 12]),
    [endUs, labelWidth, W],
  );
  const ticks = x.ticks(W < 420 ? 4 : 6);
  return (
    <figure className="m-0" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full"
        role="img"
        aria-labelledby={`${title}-t`}
      >
        <title id={`${title}-t`}>{title}</title>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={top - 4} y2={H - 4} stroke="var(--border)" />
            <text
              x={x(v)}
              y={12}
              textAnchor="middle"
              className="mono"
              fontSize={10}
              fill="var(--muted)"
            >
              {Math.round(v / 1000)}
            </text>
          </g>
        ))}
        <text x={W - 12} y={12} textAnchor="end" className="mono" fontSize={10} fill="var(--muted)">
          ms
        </text>
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const future = r.state === 'future' || r.startUs > now;
          const visibleEnd = Math.min(r.endUs, Math.max(r.startUs, now));
          const w = Math.max(2, x(r.endUs) - x(r.startUs));
          return (
            <g key={r.id}>
              <text
                x={0}
                y={y + (r.sub ? 15 : 18)}
                fontSize={12}
                fontWeight={600}
                fill={future ? 'var(--muted)' : 'var(--ink)'}
              >
                {r.label}
              </text>
              {r.sub && (
                <text x={0} y={y + 28} className="mono" fontSize={9.5} fill="var(--muted)">
                  {r.sub}
                </text>
              )}
              <rect
                x={x(r.startUs)}
                y={y + 7}
                width={w}
                height={14}
                rx={4}
                fill="none"
                stroke={layerVar(r.layer)}
                strokeDasharray={future ? '3 3' : undefined}
                opacity={future ? 0.6 : 1}
              />
              {r.splitUs !== undefined && (
                <rect
                  x={x(r.startUs)}
                  y={y + 7}
                  width={Math.max(0, x(Math.min(r.splitUs, visibleEnd)) - x(r.startUs))}
                  height={14}
                  rx={4}
                  fill={layerVar(r.layer)}
                  opacity={0.25}
                />
              )}
              <rect
                x={x(r.splitUs ?? r.startUs)}
                y={y + 7}
                width={Math.max(0, x(visibleEnd) - x(r.splitUs ?? r.startUs))}
                height={14}
                rx={4}
                fill={layerVar(r.layer)}
                opacity={0.9}
              />
            </g>
          );
        })}
        {markers.map((m, i) => {
          const ly = H - 4 - (markers.length > 1 && i % 2 === 0 ? 13 : 0);
          const right = x(m.tUs) > W - 70;
          return (
            <g key={m.id}>
              <line
                x1={x(m.tUs)}
                x2={x(m.tUs)}
                y1={top - 6}
                y2={ly - 9}
                stroke={m.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <text
                x={x(m.tUs) + (right ? -4 : 4)}
                y={ly}
                textAnchor={right ? 'end' : 'start'}
                fontSize={10}
                fill={m.color}
                fontWeight={600}
              >
                {m.label}
              </text>
            </g>
          );
        })}
        <line
          x1={x(Math.min(now, endUs))}
          x2={x(Math.min(now, endUs))}
          y1={top - 6}
          y2={H}
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
      </svg>
      <figcaption className="sr-only">
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              {t('waterfall.row', {
                label: r.label,
                start: ms(r.startUs),
                end: ms(r.endUs),
                dur: ms(r.endUs - r.startUs),
              })}
            </li>
          ))}
          {markers.map((m) => (
            <li key={m.id}>
              {m.label}: {ms(m.tUs)}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
