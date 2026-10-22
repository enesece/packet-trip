import type { CssRule, Declaration, SimpleSelector } from './css-parser';
import { parseCss, specificity } from './css-parser';
import type { MNode } from './dom';
import { attr } from './dom';

export const UA_STYLESHEET = `
html, body, div, h1, p { display: block; }
head, title, link, style, script, meta { display: none; }
a { display: inline; color: #0000ee; text-decoration: underline; }
body { margin: 8px; }
h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0; }
p { margin: 1em 0; }
`;

/** The CSS Object Model: all rules from every stylesheet, in cascade order. */
export class Cssom {
  private rules: CssRule[] = [];
  private order = 0;
  readonly sheets: string[] = [];

  constructor() {
    this.add(UA_STYLESHEET, 'user-agent');
  }

  add(text: string, source: string): number {
    const sheet = parseCss(text, source, this.order);
    this.order += sheet.rules.length;
    this.rules.push(...sheet.rules);
    this.sheets.push(source);
    return sheet.rules.length;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /** Matching declarations for an element, sorted by (origin, specificity, order). */
  match(el: MNode): Declaration[] {
    const hits: {
      spec: readonly [number, number, number];
      author: number;
      order: number;
      decls: readonly Declaration[];
    }[] = [];
    for (const r of this.rules) {
      let best: readonly [number, number, number] | null = null;
      for (const s of r.selectors) {
        if (!matches(s, el)) continue;
        const sp = specificity(s);
        if (!best || cmp(sp, best) > 0) best = sp;
      }
      if (best)
        hits.push({
          spec: best,
          author: r.source === 'user-agent' ? 0 : 1,
          order: r.order,
          decls: r.declarations,
        });
    }
    hits.sort((a, b) => a.author - b.author || cmp(a.spec, b.spec) || a.order - b.order);
    return hits.flatMap((h) => h.decls);
  }
}

function cmp(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function matches(s: SimpleSelector, el: MNode): boolean {
  if (el.kind !== 'element') return false;
  if (s.tag && s.tag !== el.tag) return false;
  if (s.id && attr(el, 'id') !== s.id) return false;
  if (s.classes.length) {
    const cls = (attr(el, 'class') ?? '').split(/\s+/);
    for (const c of s.classes) if (!cls.includes(c)) return false;
  }
  return true;
}
