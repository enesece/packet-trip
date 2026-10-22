import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DisplayItem, LayoutBox, RenderState } from '@packet-trip/engine';
import { useFormat } from '../app/format';
import { pageFont } from '../app/fonts';
import { layerVar } from '../design/layer-colors';
import type { RenderView } from '../state/ui-store';
import { IconLock } from './ui/icons';

function Item({ it, dim }: { it: DisplayItem; dim?: boolean }) {
  if (it.kind === 'rect') {
    return (
      <div
        className="absolute"
        style={{
          left: it.x,
          top: it.y,
          width: it.w,
          height: it.h,
          background: it.color,
          borderRadius: it.radius,
          opacity: dim ? 0.35 : 1,
        }}
      />
    );
  }
  return (
    <div
      className="absolute whitespace-pre"
      style={{
        left: it.x,
        top: it.y,
        height: it.h,
        lineHeight: `${it.h}px`,
        fontFamily: pageFont(it.fontFamily),
        fontSize: it.fontSize,
        fontWeight: it.fontWeight,
        color: it.color,
        textDecoration: it.underline ? 'underline' : undefined,
        opacity: dim ? 0.35 : 1,
      }}
    >
      {it.text}
    </div>
  );
}

/** A fake browser window that draws the engine's display list. */
export function FakeBrowser({
  render,
  host,
  view,
  selected,
}: {
  render: RenderState | null;
  host: string;
  view: RenderView;
  selected: number | null;
}) {
  const { t } = useFormat();
  const wrap = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const vw = render?.viewport.w ?? 600;
  const vh = render?.viewport.h ?? 420;
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1.2, el.clientWidth / vw)));
    ro.observe(el);
    setScale(Math.min(1.2, el.clientWidth / vw));
    return () => ro.disconnect();
  }, [vw]);
  const items = render?.displayList ?? [];
  const docH = Math.max(vh, ...items.map((i) => i.y + i.h));
  const boxes = (render?.layoutBoxes ?? []).filter((b) => b.kind === 'block' && b.tag !== 'html');

  return (
    <div
      className="overflow-hidden rounded-[14px] border border-line-strong bg-surface"
      data-testid="fake-browser"
    >
      <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          ))}
        </span>
        <span className="mono flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-muted">
          <IconLock size={12} /> https://{host}/
        </span>
      </div>
      <div
        ref={wrap}
        className="relative w-full overflow-hidden bg-white"
        style={{ height: docH * scale }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: vw, height: docH, transform: `scale(${scale})` }}
          role="img"
          aria-label={t('render.viewportLabel', { n: items.length })}
        >
          {!render?.painted && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-white text-[14px] text-[#8a919c]"
              style={{ fontFamily: 'var(--font-ui)' }}
            >
              {t('render.blank')}
            </div>
          )}
          {view === 'final' && items.map((it, i) => <Item key={i} it={it} />)}
          {view === 'boxes' && (
            <>
              {items.map((it, i) => (
                <Item key={i} it={it} dim />
              ))}
              {boxes.map((b) => (
                <BoxOutline
                  key={`${b.nodeId}-${b.x}-${b.y}`}
                  b={b}
                  selected={selected === b.nodeId}
                />
              ))}
            </>
          )}
          {view === 'paint' && <PaintLayers items={items} />}
        </div>
      </div>
    </div>
  );
}

function BoxOutline({ b, selected }: { b: LayoutBox; selected: boolean }) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        border: `${selected ? 2 : 1}px ${selected ? 'solid' : 'dashed'} ${selected ? 'var(--layer-browser)' : '#9aa1ad'}`,
        borderRadius: 4,
      }}
    >
      <span
        className="absolute left-1 top-0.5 rounded px-1 text-[10px] font-semibold"
        style={{
          fontFamily: 'var(--font-mono)',
          background: selected ? 'var(--layer-browser)' : '#eef0f3',
          color: selected ? '#fff' : '#3b414d',
        }}
      >
        {b.tag} · {Math.round(b.w)} × {Math.round(b.h)}
      </span>
    </div>
  );
}

/** Each display-list item flashes in paint order; reduced motion shows numbered items instead. */
function PaintLayers({ items }: { items: readonly DisplayItem[] }) {
  const [i, setI] = useState(0);
  const reduce =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    if (reduce || items.length === 0) return;
    setI(0);
    const id = window.setInterval(() => setI((x) => (x + 1) % (items.length + 3)), 420);
    return () => window.clearInterval(id);
  }, [items, reduce]);
  const shown = reduce ? items.length : Math.min(i + 1, items.length);
  return (
    <>
      {items.slice(0, shown).map((it, k) => (
        <Item key={k} it={it} />
      ))}
      {items.slice(0, shown).map((it, k) =>
        reduce || k === shown - 1 ? (
          <div
            key={`o${k}`}
            className="pointer-events-none absolute"
            style={{
              left: it.x - 2,
              top: it.y - 2,
              width: it.w + 4,
              height: it.h + 4,
              border: `2px solid ${layerVar('browser')}`,
              borderRadius: 4,
            }}
          >
            <span
              className="absolute -top-2.5 right-0 rounded px-1 text-[10px] font-bold text-white"
              style={{ background: 'var(--layer-browser)', fontFamily: 'var(--font-mono)' }}
            >
              {k + 1}
            </span>
          </div>
        ) : null,
      )}
    </>
  );
}
