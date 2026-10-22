import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeId, PacketSummary } from '@packet-trip/engine';
import { useRun } from '../state/use-sim';
import { useUi } from '../state/ui-store';
import { useFormat } from '../app/format';
import { layerVar } from '../design/layer-colors';

interface Pos {
  readonly x: number;
  readonly y: number;
}

const W = 1000;
const H = 470;

const POS: Readonly<Record<NodeId, Pos>> = {
  laptop: { x: 80, y: 330 },
  router: { x: 230, y: 330 },
  isp1: { x: 345, y: 330 },
  isp2: { x: 415, y: 330 },
  isp3: { x: 485, y: 330 },
  isp4: { x: 555, y: 330 },
  resolver: { x: 660, y: 130 },
  root: { x: 880, y: 40 },
  tld: { x: 880, y: 108 },
  ns1: { x: 880, y: 176 },
  ns2: { x: 880, y: 244 },
  cdn: { x: 720, y: 345 },
  origin: { x: 900, y: 425 },
};

const ISP: readonly NodeId[] = ['isp1', 'isp2', 'isp3', 'isp4'];
const TRUNK: readonly NodeId[] = ['laptop', 'router', 'isp1', 'isp2', 'isp3', 'isp4'];
const NS: readonly NodeId[] = ['root', 'tld', 'ns1', 'ns2'];

/** Offset for the two "lanes" sharing the trunk: DNS above, TCP/TLS below. */
function laneOffset(p: PacketSummary, a: NodeId, b: NodeId): number {
  const onTrunk = TRUNK.includes(a) && TRUNK.includes(b);
  if (!onTrunk) return 0;
  return p.flow === 'dns' ? -7 : 7;
}

function boxFor(id: NodeId): { w: number; h: number } {
  if (ISP.includes(id)) return { w: 14, h: 14 };
  if (NS.includes(id)) return { w: 168, h: 46 };
  return { w: 140, h: 50 };
}

export function NetworkMap() {
  const { t } = useFormat();
  const run = useRun();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dotsRef = useRef<SVGGElement | null>(null);
  const hlRef = useRef<SVGGElement | null>(null);
  const [hover, setHover] = useState<NodeId | null>(null);
  const viaCdn = run?.site.cdn ?? true;
  const showNs2 = run?.config.ns1Timeout ?? false;

  const nodes = useMemo(() => {
    const byId = new Map(run?.nodes.map((n) => [n.id, n]) ?? []);
    return (Object.keys(POS) as NodeId[])
      .filter((id) => id !== 'ns2' || showNs2)
      .map((id) => ({ id, pos: POS[id], info: byId.get(id) }));
  }, [run, showNs2]);

  // rAF loop: moves packet dots without re-rendering React.
  useEffect(() => {
    const g = dotsRef.current;
    const hl = hlRef.current;
    if (!g || !hl || !run) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const NSURI = 'http://www.w3.org/2000/svg';
    const pool: SVGCircleElement[] = [];
    const segs = new Map<string, SVGLineElement>();
    const segFor = (a: NodeId, b: NodeId): SVGLineElement => {
      const k = `${a}>${b}`;
      let el = segs.get(k);
      if (!el) {
        el = document.createElementNS(NSURI, 'line');
        el.setAttribute('x1', String(POS[a].x));
        el.setAttribute('y1', String(POS[a].y));
        el.setAttribute('x2', String(POS[b].x));
        el.setAttribute('y2', String(POS[b].y));
        el.setAttribute('stroke-width', '5');
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('opacity', '0.55');
        hl.appendChild(el);
        segs.set(k, el);
      }
      return el;
    };
    const packets = run.packets;
    let raf = 0;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const now = useUi.getState().playheadUs;
      let used = 0;
      const lit = new Set<string>();
      for (const p of packets) {
        const first = p.hops[0];
        const last = p.hops[p.hops.length - 1];
        if (!first || !last || now < first.tUs) continue;
        const endT = p.lost ? last.tUs + 3000 : last.tUs;
        if (now > endT) continue;
        let i = 0;
        while (i < p.hops.length - 1 && (p.hops[i + 1]?.tUs ?? Infinity) <= now) i++;
        const a = p.hops[i];
        const b = p.hops[i + 1];
        if (!a) continue;
        let x: number;
        let y: number;
        if (b) {
          const f = Math.min(1, Math.max(0, (now - a.tUs) / Math.max(1, b.tUs - a.tUs)));
          const pa = POS[a.node];
          const pb = POS[b.node];
          const off = laneOffset(p, a.node, b.node);
          x = pa.x + (pb.x - pa.x) * f;
          y = pa.y + (pb.y - pa.y) * f + off;
          if (reduce) {
            const s = segFor(a.node, b.node);
            s.setAttribute('stroke', layerVar(p.topLayer));
            lit.add(`${a.node}>${b.node}`);
            continue;
          }
        } else {
          // Lost packets fade where they were dropped.
          const pa = POS[a.node];
          x = pa.x + 18;
          y = pa.y + laneOffset(p, a.node, 'router');
        }
        if (reduce) continue;
        let c = pool[used];
        if (!c) {
          c = document.createElementNS(NSURI, 'circle');
          c.setAttribute('r', '5.5');
          c.setAttribute('stroke', 'var(--surface)');
          c.setAttribute('stroke-width', '1.5');
          g.appendChild(c);
          pool.push(c);
        }
        used++;
        c.setAttribute('cx', x.toFixed(1));
        c.setAttribute('cy', y.toFixed(1));
        c.setAttribute('fill', p.lost && !b ? 'var(--danger)' : layerVar(p.topLayer));
        c.setAttribute(
          'opacity',
          p.lost && !b ? String(Math.max(0, 1 - (now - last.tUs) / 3000)) : '1',
        );
        c.style.display = '';
      }
      for (let k = used; k < pool.length; k++) {
        const c = pool[k];
        if (c) c.style.display = 'none';
      }
      for (const [k, el] of segs) el.style.display = lit.has(k) ? '' : 'none';
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      pool.forEach((c) => c.remove());
      segs.forEach((s) => s.remove());
    };
  }, [run]);

  const line = (
    a: NodeId,
    b: NodeId,
    cls: { stroke: string; dash?: string; width?: number; off?: number; opacity?: number },
    key: string,
  ) => {
    const pa = POS[a];
    const pb = POS[b];
    const off = cls.off ?? 0;
    return (
      <line
        key={key}
        x1={pa.x}
        y1={pa.y + off}
        x2={pb.x}
        y2={pb.y + off}
        stroke={cls.stroke}
        strokeWidth={cls.width ?? 2}
        strokeDasharray={cls.dash}
        strokeLinecap="round"
        opacity={cls.opacity ?? 1}
      />
    );
  };

  const trunkPairs: [NodeId, NodeId][] = TRUNK.slice(0, -1).map((n, i) => [
    n,
    TRUNK[i + 1] as NodeId,
  ]);
  const app = layerVar('application');
  const tra = layerVar('transport');
  const sec = layerVar('security');

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[620px]"
          role="img"
          aria-labelledby="map-title map-desc"
        >
          <title id="map-title">{t('map.title')}</title>
          <desc id="map-desc">{t('map.desc')}</desc>
          {/* ISP cloud */}
          <rect
            x={318}
            y={290}
            width={264}
            height={80}
            rx={16}
            fill="var(--surface-2)"
            stroke="var(--border)"
          />
          <text
            x={450}
            y={308}
            textAnchor="middle"
            className="mono"
            fontSize={11}
            fill="var(--muted)"
          >
            {t('map.isp')}
          </text>
          {/* DNS lane: dashed orange */}
          {trunkPairs.map(([a, b]) =>
            line(a, b, { stroke: app, dash: '6 5', off: -7 }, `dns-${a}`),
          )}
          {line('isp4', 'resolver', { stroke: app, dash: '6 5' }, 'dns-res')}
          {NS.filter((n) => n !== 'ns2' || showNs2).map((n) =>
            line('resolver', n, { stroke: app, dash: '6 5' }, `dns-${n}`),
          )}
          {/* TCP/TLS path: blue with a thin violet line alongside */}
          {trunkPairs.map(([a, b]) => line(a, b, { stroke: tra, off: 7 }, `tcp-${a}`))}
          {trunkPairs.map(([a, b]) => line(a, b, { stroke: sec, off: 12, width: 1 }, `tls-${a}`))}
          {viaCdn ? (
            <>
              {line('isp4', 'cdn', { stroke: tra }, 'tcp-cdn')}
              {line('isp4', 'cdn', { stroke: sec, off: 5, width: 1 }, 'tls-cdn')}
              {line(
                'cdn',
                'origin',
                { stroke: 'var(--border-strong)', dash: '4 5', width: 2 },
                'origin',
              )}
              <text
                x={(POS.cdn.x + POS.origin.x) / 2 - 8}
                y={(POS.cdn.y + POS.origin.y) / 2 + 22}
                textAnchor="middle"
                fontSize={12}
                fill="var(--muted)"
              >
                {t('map.cacheMiss')}
              </text>
            </>
          ) : (
            <>
              {line('isp4', 'origin', { stroke: tra }, 'tcp-origin')}
              {line('isp4', 'origin', { stroke: sec, off: 5, width: 1 }, 'tls-origin')}
            </>
          )}
          <g ref={hlRef} />
          {/* Nodes */}
          {nodes.map(({ id, pos, info }) => {
            const { w, h } = boxFor(id);
            const isIsp = ISP.includes(id);
            const muted = id === 'cdn' && !viaCdn;
            return (
              <g
                key={id}
                tabIndex={0}
                role="button"
                aria-label={`${info?.name ?? id}, ${info?.address ?? ''}. ${t('map.nodeHint')}`}
                onMouseEnter={() => setHover(id)}
                onMouseLeave={() => setHover((h0) => (h0 === id ? null : h0))}
                onFocus={() => setHover(id)}
                onBlur={() => setHover((h0) => (h0 === id ? null : h0))}
                opacity={muted ? 0.4 : 1}
                className="outline-none [&:focus-visible>rect]:stroke-[var(--focus)] [&:focus-visible>rect]:[stroke-width:2.5]"
              >
                {isIsp ? (
                  <rect
                    x={pos.x - 7}
                    y={pos.y - 7}
                    width={14}
                    height={14}
                    rx={4}
                    fill="var(--surface)"
                    stroke="var(--border-strong)"
                    strokeWidth={1.5}
                  />
                ) : (
                  <>
                    <rect
                      x={pos.x - w / 2}
                      y={pos.y - h / 2}
                      width={w}
                      height={h}
                      rx={12}
                      fill="var(--surface)"
                      stroke={hover === id ? 'var(--ink)' : 'var(--border-strong)'}
                      strokeWidth={hover === id ? 1.5 : 1}
                    />
                    <text
                      x={pos.x}
                      y={pos.y - 4}
                      textAnchor="middle"
                      fontSize={13}
                      fontWeight={600}
                      fill="var(--ink)"
                    >
                      {id === 'tld' || id === 'ns1' || id === 'ns2' ? info?.name : t(`node.${id}`)}
                    </text>
                    <text
                      x={pos.x}
                      y={pos.y + 13}
                      textAnchor="middle"
                      className="mono"
                      fontSize={11}
                      fill="var(--muted)"
                    >
                      {id === 'cdn' ? `${info?.address}:443` : info?.address}
                    </text>
                  </>
                )}
              </g>
            );
          })}
          <g ref={dotsRef} />
        </svg>
      </div>
      {hover && run && <NodePackets node={hover} pos={POS[hover]} packets={run.packets} />}
      <div className="sr-only">
        <h3>{t('map.listTitle')}</h3>
        <ul>
          {nodes.map(({ id, info }) => (
            <li key={id}>
              {info?.name} — {info?.address}
            </li>
          ))}
        </ul>
        <p>{t('map.edgesText')}</p>
      </div>
    </div>
  );
}

function NodePackets({
  node,
  pos,
  packets,
}: {
  node: NodeId;
  pos: Pos;
  packets: readonly PacketSummary[];
}) {
  const { t, ms } = useFormat();
  const now = useUi((s) => s.playheadUs);
  const seen = packets.filter((p) => p.hops.some((h) => h.node === node && h.tUs <= now));
  const left = `${(pos.x / W) * 100}%`;
  const top = `${(pos.y / H) * 100}%`;
  const flip = pos.x > W * 0.6;
  return (
    <div
      role="tooltip"
      className="panel pointer-events-none absolute z-10 w-[260px] p-3 shadow-lg"
      style={{ left, top, transform: `translate(${flip ? 'calc(-100% - 20px)' : '20px'}, -50%)` }}
    >
      <p className="text-[13px] font-semibold">{t('map.seen', { count: seen.length })}</p>
      <ul className="mt-2 max-h-[180px] space-y-1 overflow-hidden">
        {seen.slice(-8).map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: layerVar(p.topLayer) }}
            />
            <span className="mono text-muted">#{p.id}</span>
            <span className="truncate">{p.name}</span>
            <span className="mono ml-auto shrink-0 text-muted">{ms(p.tUs, 1)}</span>
          </li>
        ))}
      </ul>
      {seen.length > 8 && (
        <p className="mt-1 text-[12px] text-muted">{t('map.more', { count: seen.length - 8 })}</p>
      )}
    </div>
  );
}
