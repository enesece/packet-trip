import type { FontTable } from '@packet-trip/engine';

/** Families the simulated page uses, and the real font each is drawn with. */
export const PAGE_FONT_CSS: Readonly<Record<string, string>> = {
  'Trip Sans': '"Instrument Sans", sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  serif: 'Georgia, "Times New Roman", serif',
  'sans-serif': 'sans-serif',
  'system-ui': 'system-ui, sans-serif',
};

export function pageFont(family: string): string {
  return PAGE_FONT_CSS[family] ?? `${family}, serif`;
}

/**
 * Measures printable-ASCII advance widths at 100px with canvas, so the engine's layout matches
 * what the fake browser draws. Returns null where canvas is unavailable (tests).
 */
export async function measureFontTable(): Promise<FontTable | null> {
  if (typeof document === 'undefined') return null;
  try {
    await Promise.all([
      document.fonts.load('400 100px "Instrument Sans"'),
      document.fonts.load('700 100px "Instrument Sans"'),
    ]);
  } catch {
    // fall through with whatever is available
  }
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const table: Record<string, Record<string, number[]>> = {};
  for (const [family, css] of Object.entries(PAGE_FONT_CSS)) {
    table[family] = {};
    for (const weight of [400, 700]) {
      ctx.font = `${weight} 100px ${css}`;
      const widths: number[] = [];
      for (let c = 32; c <= 126; c++) widths.push(ctx.measureText(String.fromCharCode(c)).width);
      table[family][String(weight)] = widths;
    }
  }
  return table;
}
