/** Text measurement is injected so the engine stays DOM-free. */
export interface FontSpec {
  readonly family: string;
  readonly size: number;
  readonly weight: number;
}

export type TextMeasurer = (text: string, font: FontSpec) => number;

/**
 * Advance widths for printable ASCII (codes 32–126) at 100px, per family and weight,
 * measured in the web app with canvas measureText and passed to the engine.
 */
export interface FontTable {
  readonly [family: string]: { readonly [weight: string]: readonly number[] };
}

/** Deterministic approximation used in Node tests and as a fallback for unknown families. */
export const approximateMeasurer: TextMeasurer = (text, font) => {
  const serif = /georgia|serif|times/i.test(font.family) && !/sans/i.test(font.family);
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += 0.25;
    else if ("iljtf.,:;'!|".includes(ch)) em += 0.28;
    else if ('mwMW'.includes(ch)) em += 0.82;
    else if (ch >= 'A' && ch <= 'Z') em += 0.66;
    else if (ch >= '0' && ch <= '9') em += 0.55;
    else em += serif ? 0.5 : 0.52;
  }
  return em * font.size * (font.weight >= 600 ? 1.06 : 1);
};

export function tableMeasurer(
  table: FontTable,
  fallback: TextMeasurer = approximateMeasurer,
): TextMeasurer {
  return (text, font) => {
    const fam = table[font.family];
    if (!fam) return fallback(text, font);
    const widths = fam[String(font.weight >= 600 ? 700 : 400)] ?? fam['400'];
    if (!widths) return fallback(text, font);
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const adv = c >= 32 && c <= 126 ? widths[c - 32] : undefined;
      w += adv !== undefined ? adv : (fallback(text[i] ?? ' ', { ...font, size: 100 }) as number);
    }
    return (w * font.size) / 100;
  };
}

/** Picks the first family in the stack that is available (web fonts only once loaded). */
export function resolveFamily(
  stack: readonly string[],
  webFonts: ReadonlySet<string>,
  loaded: ReadonlySet<string>,
): string {
  for (const f of stack) {
    if (webFonts.has(f)) {
      if (loaded.has(f)) return f;
      continue;
    }
    return f;
  }
  return 'serif';
}
