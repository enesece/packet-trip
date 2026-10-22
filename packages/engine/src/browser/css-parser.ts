/**
 * A small CSS parser: comments, rule sets with comma-separated compound selectors
 * (type, .class, #id), declarations. At-rules such as @font-face are skipped.
 */

export interface SimpleSelector {
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
}

export interface Declaration {
  readonly property: string;
  readonly value: string;
}

export interface CssRule {
  readonly selectors: readonly SimpleSelector[];
  readonly declarations: readonly Declaration[];
  /** Order of appearance across all stylesheets (for cascade ties). */
  readonly order: number;
  readonly source: string;
}

export interface ParsedSheet {
  readonly rules: readonly CssRule[];
  readonly skippedAtRules: readonly string[];
}

export function parseSelector(s: string): SimpleSelector | null {
  const t = s.trim();
  if (!/^[a-zA-Z0-9.#_-]+$/.test(t)) return null; // combinators and pseudo-classes are not supported
  let tag: string | null = null;
  let id: string | null = null;
  const classes: string[] = [];
  const re = /([.#]?)([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const kind = m[1];
    const name = m[2] ?? '';
    if (kind === '.') classes.push(name);
    else if (kind === '#') id = name;
    else tag = name.toLowerCase();
  }
  return { tag, id, classes };
}

export function specificity(s: SimpleSelector): readonly [number, number, number] {
  return [s.id ? 1 : 0, s.classes.length, s.tag ? 1 : 0];
}

export function parseCss(text: string, source: string, orderStart = 0): ParsedSheet {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const skipped: string[] = [];
  let i = 0;
  let order = orderStart;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i] ?? '')) i++;
    if (i >= css.length) break;
    if (css[i] === '@') {
      // Skip the at-rule: either up to ';' or a balanced {...} block.
      const nameMatch = /^@[a-zA-Z-]+/.exec(css.slice(i));
      skipped.push(nameMatch?.[0] ?? '@');
      let depth = 0;
      for (; i < css.length; i++) {
        const c = css[i];
        if (c === ';' && depth === 0) {
          i++;
          break;
        }
        if (c === '{') depth++;
        if (c === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      continue;
    }
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const close = css.indexOf('}', open);
    if (close < 0) break;
    const selText = css.slice(i, open);
    const body = css.slice(open + 1, close);
    i = close + 1;
    const selectors = selText
      .split(',')
      .map(parseSelector)
      .filter((s): s is SimpleSelector => s !== null);
    if (selectors.length === 0) continue;
    const declarations: Declaration[] = [];
    for (const part of body.split(';')) {
      const c = part.indexOf(':');
      if (c < 0) continue;
      const property = part.slice(0, c).trim().toLowerCase();
      const value = part.slice(c + 1).trim();
      if (property && value) declarations.push({ property, value });
    }
    rules.push({ selectors, declarations, order: order++, source });
  }
  return { rules, skippedAtRules: skipped };
}
