import type { LayoutBox } from '../model';
import type { StyledNode } from './style';
import type { FontSpec, TextMeasurer } from './measure';

export interface TextFragment {
  readonly nodeId: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly baseline: number;
  readonly font: FontSpec;
  readonly color: string;
  readonly underline: boolean;
}

export interface BlockBox {
  readonly nodeId: number;
  readonly tag: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly background: string | null;
  readonly radius: number;
}

export interface LayoutResult {
  readonly blocks: readonly BlockBox[];
  readonly lines: readonly LayoutBox[];
  readonly texts: readonly TextFragment[];
  readonly height: number;
  readonly canvasBackground: string | null;
}

interface InlineItem {
  readonly nodeId: number;
  readonly text: string;
  readonly style: StyledNode['style'];
}

export interface LayoutEnv {
  readonly measure: TextMeasurer;
  readonly family: (stack: readonly string[]) => string;
}

/** Block flow with sibling margin collapsing, plus greedy inline line breaking. */
export function layout(root: StyledNode, viewportW: number, env: LayoutEnv): LayoutResult {
  const blocks: BlockBox[] = [];
  const lines: LayoutBox[] = [];
  const texts: TextFragment[] = [];

  const isBlock = (n: StyledNode): boolean =>
    n.node.kind === 'element' && n.style.display === 'block';

  const collectInline = (n: StyledNode, out: InlineItem[]): void => {
    if (n.node.kind === 'text') {
      out.push({ nodeId: n.node.id, text: n.node.text, style: n.style });
      return;
    }
    for (const c of n.children) collectInline(c, out);
  };

  const layoutInline = (items: InlineItem[], x0: number, y0: number, width: number): number => {
    // Tokenize into words, collapsing whitespace.
    type Word = { item: InlineItem; text: string; space: boolean };
    const words: Word[] = [];
    let pendingSpace = false;
    for (const it of items) {
      const parts = it.text.split(/(\s+)/);
      for (const p of parts) {
        if (p === '') continue;
        if (/^\s+$/.test(p)) {
          pendingSpace = true;
          continue;
        }
        words.push({ item: it, text: p, space: pendingSpace && words.length > 0 });
        pendingSpace = false;
      }
    }
    if (words.length === 0) return 0;
    let y = y0;
    let line: { w: Word; x: number; width: number }[] = [];
    let cx = 0;
    const font = (it: InlineItem): FontSpec => ({
      family: env.family(it.style.fontFamily),
      size: it.style.fontSize,
      weight: it.style.fontWeight,
    });
    const flush = (): void => {
      if (line.length === 0) return;
      const lh = Math.max(...line.map((l) => l.w.item.style.lineHeight));
      const maxSize = Math.max(...line.map((l) => l.w.item.style.fontSize));
      const baseline = y + (lh - maxSize) / 2 + maxSize * 0.8;
      lines.push({
        nodeId: line[0]?.w.item.nodeId ?? 0,
        tag: 'line',
        x: x0,
        y,
        w: cx,
        h: lh,
        kind: 'line',
      });
      // Merge consecutive words of the same node into one fragment.
      let i = 0;
      while (i < line.length) {
        const first = line[i];
        if (!first) break;
        let j = i;
        let text = first.w.text;
        let end = first.x + first.width;
        while (j + 1 < line.length && line[j + 1]?.w.item === first.w.item) {
          j++;
          const nx = line[j];
          if (!nx) break;
          text += (nx.w.space ? ' ' : '') + nx.w.text;
          end = nx.x + nx.width;
        }
        const st = first.w.item.style;
        texts.push({
          nodeId: first.w.item.nodeId,
          text,
          x: x0 + first.x,
          y,
          w: end - first.x,
          h: lh,
          baseline,
          font: font(first.w.item),
          color: st.color,
          underline: st.underline,
        });
        i = j + 1;
      }
      y += lh;
      line = [];
      cx = 0;
    };
    for (const w of words) {
      const f = font(w.item);
      const spaceW = w.space ? env.measure(' ', f) : 0;
      const ww = env.measure(w.text, f);
      if (line.length > 0 && cx + spaceW + ww > width) {
        flush();
        line.push({ w: { ...w, space: false }, x: 0, width: ww });
        cx = ww;
      } else {
        const x = cx + (line.length > 0 ? spaceW : 0);
        line.push({ w: line.length > 0 ? w : { ...w, space: false }, x, width: ww });
        cx = x + ww;
      }
    }
    flush();
    return y - y0;
  };

  /** Lays out a block; returns its margin-box height excluding collapsed margins handled by the parent. */
  const layoutBlock = (
    n: StyledNode,
    x: number,
    y: number,
    containerW: number,
  ): { h: number; mt: number; mb: number } => {
    const s = n.style;
    const pad = s.padding;
    const mlRaw = s.margin.left;
    const mrRaw = s.margin.right;
    let ml = mlRaw === 'auto' ? 0 : mlRaw;
    let mr = mrRaw === 'auto' ? 0 : mrRaw;
    let contentW = s.width ?? containerW - ml - mr - pad.left - pad.right;
    if (s.maxWidth !== null) contentW = Math.min(contentW, s.maxWidth);
    contentW = Math.max(0, contentW);
    const boxW = contentW + pad.left + pad.right;
    if (mlRaw === 'auto' && mrRaw === 'auto') {
      const free = Math.max(0, containerW - boxW);
      ml = free / 2;
      mr = free / 2;
    } else if (mlRaw === 'auto') {
      ml = Math.max(0, containerW - boxW - mr);
    }
    const bx = x + ml;
    const cx = bx + pad.left;
    let cy = y + pad.top;
    const blockIndex = blocks.length;
    blocks.push({
      nodeId: n.node.id,
      tag: n.node.tag,
      x: bx,
      y,
      w: boxW,
      h: 0,
      background: s.background,
      radius: s.borderRadius,
    });

    const kids = n.children;
    const hasBlockKids = kids.some(isBlock);
    if (!hasBlockKids) {
      const items: InlineItem[] = [];
      for (const k of kids) collectInline(k, items);
      cy += layoutInline(items, cx, cy, contentW);
    } else {
      let prevMb = 0;
      let first = true;
      let inlineRun: InlineItem[] = [];
      const flushRun = (): void => {
        const hasText = inlineRun.some((i) => i.text.trim() !== '');
        if (hasText) {
          cy += prevMb;
          prevMb = 0;
          cy += layoutInline(inlineRun, cx, cy, contentW);
          first = false;
        }
        inlineRun = [];
      };
      for (const k of kids) {
        if (!isBlock(k)) {
          collectInline(k, inlineRun);
          continue;
        }
        flushRun();
        const mt = k.style.margin.top;
        const gap = first ? mt : Math.max(prevMb, mt);
        const r = layoutBlock(k, cx, cy + gap, contentW);
        cy += gap + r.h;
        prevMb = r.mb;
        first = false;
      }
      flushRun();
      cy += prevMb;
    }
    const h = cy + pad.bottom - y;
    const b = blocks[blockIndex];
    if (b) blocks[blockIndex] = { ...b, h };
    return { h, mt: s.margin.top, mb: s.margin.bottom };
  };

  const r = layoutBlock(root, 0, root.style.margin.top, viewportW);
  const height = r.h + r.mt + r.mb;
  const canvasBackground =
    root.style.background ??
    root.children.find((c) => c.node.tag === 'body')?.style.background ??
    null;
  return { blocks, lines, texts, height, canvasBackground };
}
