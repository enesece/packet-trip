import type { Cssom } from './cssom';
import type { MNode } from './dom';

export interface Edges {
  readonly top: number;
  readonly right: number | 'auto';
  readonly bottom: number;
  readonly left: number | 'auto';
}

export interface ComputedStyle {
  readonly display: 'block' | 'inline' | 'none';
  readonly margin: Edges;
  readonly padding: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly width: number | null;
  readonly maxWidth: number | null;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly color: string;
  readonly background: string | null;
  readonly fontFamily: readonly string[];
  readonly fontWeight: number;
  readonly borderRadius: number;
  readonly underline: boolean;
}

export const ROOT_STYLE: ComputedStyle = {
  display: 'block',
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  width: null,
  maxWidth: null,
  fontSize: 16,
  lineHeight: 16 * 1.2,
  color: '#000000',
  background: null,
  fontFamily: ['serif'],
  fontWeight: 400,
  borderRadius: 0,
  underline: false,
};

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  transparent: 'transparent',
};

export function parseColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
}

function length(
  v: string,
  fontSize: number,
  parentFontSize: number,
  forFontSize = false,
): number | null {
  const s = v.trim().toLowerCase();
  if (s === '0') return 0;
  const m = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'em') return n * (forFontSize ? parentFontSize : fontSize);
  if (m[2] === 'rem') return n * 16;
  if (m[2] === undefined && n !== 0) return null;
  return n;
}

function edges(v: string, fs: number, pfs: number, allowAuto: boolean): (number | 'auto')[] | null {
  const parts = v.trim().split(/\s+/);
  const vals = parts.map((p) => (allowAuto && p === 'auto' ? 'auto' : length(p, fs, pfs)));
  if (vals.some((x) => x === null)) return null;
  const [a, b = a, c = a, d = b] = vals as (number | 'auto')[];
  return [a as number | 'auto', b as number | 'auto', c as number | 'auto', d as number | 'auto'];
}

const num = (x: number | 'auto'): number => (x === 'auto' ? 0 : x);

/** Computes style for an element from the CSSOM and its parent's computed style. */
export function computeStyle(el: MNode, cssom: Cssom, parent: ComputedStyle): ComputedStyle {
  const decls = cssom.match(el);
  // Font size first: em units depend on it.
  let fontSize = parent.fontSize;
  for (const d of decls) {
    if (d.property === 'font-size')
      fontSize = length(d.value, parent.fontSize, parent.fontSize, true) ?? fontSize;
  }
  const s = {
    display: 'inline' as ComputedStyle['display'],
    margin: { top: 0, right: 0 as number | 'auto', bottom: 0, left: 0 as number | 'auto' },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    width: null as number | null,
    maxWidth: null as number | null,
    fontSize,
    lineHeight: (parent.lineHeight / parent.fontSize) * fontSize,
    lineHeightFactor: parent.lineHeight / parent.fontSize,
    color: parent.color,
    background: null as string | null,
    fontFamily: parent.fontFamily,
    fontWeight: parent.fontWeight,
    borderRadius: 0,
    underline: parent.underline,
  };
  for (const { property: p, value: v } of decls) {
    switch (p) {
      case 'display':
        if (v === 'block' || v === 'inline' || v === 'none') s.display = v;
        break;
      case 'margin': {
        const e = edges(v, fontSize, parent.fontSize, true);
        if (e)
          s.margin = {
            top: num(e[0] ?? 0),
            right: e[1] ?? 0,
            bottom: num(e[2] ?? 0),
            left: e[3] ?? 0,
          };
        break;
      }
      case 'margin-top':
      case 'margin-bottom': {
        const l = length(v, fontSize, parent.fontSize);
        if (l !== null) s.margin = { ...s.margin, [p === 'margin-top' ? 'top' : 'bottom']: l };
        break;
      }
      case 'margin-left':
      case 'margin-right': {
        const l = v === 'auto' ? 'auto' : length(v, fontSize, parent.fontSize);
        if (l !== null) s.margin = { ...s.margin, [p === 'margin-left' ? 'left' : 'right']: l };
        break;
      }
      case 'padding': {
        const e = edges(v, fontSize, parent.fontSize, false);
        if (e)
          s.padding = {
            top: num(e[0] ?? 0),
            right: num(e[1] ?? 0),
            bottom: num(e[2] ?? 0),
            left: num(e[3] ?? 0),
          };
        break;
      }
      case 'width':
        s.width = length(v, fontSize, parent.fontSize);
        break;
      case 'max-width':
        s.maxWidth = length(v, fontSize, parent.fontSize);
        break;
      case 'line-height': {
        const unitless = /^\d*\.?\d+$/.test(v.trim());
        if (unitless) {
          s.lineHeightFactor = Number(v);
          s.lineHeight = Number(v) * fontSize;
        } else {
          const l = length(v, fontSize, parent.fontSize);
          if (l !== null) {
            s.lineHeight = l;
            s.lineHeightFactor = l / fontSize;
          }
        }
        break;
      }
      case 'color':
        s.color = parseColor(v) ?? s.color;
        break;
      case 'background':
      case 'background-color':
        s.background = parseColor(v);
        break;
      case 'font-family':
        s.fontFamily = v.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
        break;
      case 'font-weight':
        s.fontWeight = v === 'bold' ? 700 : v === 'normal' ? 400 : Number(v) || s.fontWeight;
        break;
      case 'border-radius':
        s.borderRadius = length(v, fontSize, parent.fontSize) ?? 0;
        break;
      case 'text-decoration':
        s.underline = v.includes('underline');
        break;
      default:
        break;
    }
  }
  // line-height inherits as a factor when it was unitless upstream
  if (!decls.some((d) => d.property === 'line-height'))
    s.lineHeight = s.lineHeightFactor * fontSize;
  return {
    display: s.display,
    margin: s.margin,
    padding: s.padding,
    width: s.width,
    maxWidth: s.maxWidth,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    color: s.color,
    background: s.background === 'transparent' ? null : s.background,
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    borderRadius: s.borderRadius,
    underline: s.underline,
  };
}

export interface StyledNode {
  readonly node: MNode;
  readonly style: ComputedStyle;
  readonly children: readonly StyledNode[];
}

/** Builds the render tree: styled nodes, skipping display:none subtrees. */
export function buildRenderTree(root: MNode, cssom: Cssom): StyledNode | null {
  const html = root.children.find((c) => c.kind === 'element' && c.tag === 'html');
  if (!html) return null;
  const rec = (n: MNode, parent: ComputedStyle): StyledNode | null => {
    if (n.kind === 'text') return { node: n, style: parent, children: [] };
    if (n.kind !== 'element') return null;
    const st = computeStyle(n, cssom, parent);
    if (st.display === 'none') return null;
    const kids: StyledNode[] = [];
    for (const c of n.children) {
      const k = rec(c, st);
      if (k) kids.push(k);
    }
    return { node: n, style: st, children: kids };
  };
  return rec(html, ROOT_STYLE);
}
