import type { DisplayItem, LayoutBox } from '../model';
import type { LayoutResult } from './layout';

/** Turns layout into a display list: backgrounds first (tree order), then text. */
export function paint(l: LayoutResult, viewportW: number, viewportH: number): DisplayItem[] {
  const out: DisplayItem[] = [];
  if (l.canvasBackground) {
    out.push({
      kind: 'rect',
      nodeId: 0,
      x: 0,
      y: 0,
      w: viewportW,
      h: Math.max(viewportH, l.height),
      color: l.canvasBackground,
      radius: 0,
    });
  }
  for (const b of l.blocks) {
    if (!b.background || b.tag === 'html') continue;
    out.push({
      kind: 'rect',
      nodeId: b.nodeId,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      color: b.background,
      radius: b.radius,
    });
  }
  for (const t of l.texts) {
    out.push({
      kind: 'text',
      nodeId: t.nodeId,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      baseline: t.baseline,
      text: t.text,
      color: t.color,
      fontFamily: t.font.family,
      fontSize: t.font.size,
      fontWeight: t.font.weight,
      underline: t.underline,
    });
  }
  return out;
}

export function layoutBoxes(l: LayoutResult): LayoutBox[] {
  return [
    ...l.blocks.map((b) => ({
      nodeId: b.nodeId,
      tag: b.tag,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      kind: 'block' as const,
    })),
    ...l.texts.map((t) => ({
      nodeId: t.nodeId,
      tag: '#text',
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      kind: 'text' as const,
    })),
  ];
}
