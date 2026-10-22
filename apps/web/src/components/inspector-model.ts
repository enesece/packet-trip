import type { Field, LayerId, LayerNode } from '@packet-trip/engine';

export interface ByteInfo {
  readonly fieldId: string;
  readonly layer: LayerId;
  /** Alternates between neighbouring fields so they are distinguishable. */
  readonly shade: number;
}

export interface FlatField {
  readonly field: Field;
  readonly layer: LayerNode;
  readonly depth: number;
}

/** Leaf fields win: each byte maps to the innermost field that covers it. */
export function byteMap(len: number, layers: readonly LayerNode[]): (ByteInfo | null)[] {
  const map: (ByteInfo | null)[] = new Array<ByteInfo | null>(len).fill(null);
  let n = 0;
  const visit = (f: Field, layer: LayerId): void => {
    const shade = n++ % 2;
    for (let i = f.byteRange[0]; i < Math.min(len, f.byteRange[1]); i++)
      map[i] = { fieldId: f.id, layer, shade };
    for (const c of f.children ?? []) visit(c, layer);
  };
  for (const l of layers) for (const f of l.fields) visit(f, l.layer);
  return map;
}

export function flatten(layers: readonly LayerNode[], expert: boolean): FlatField[] {
  const out: FlatField[] = [];
  const visit = (f: Field, layer: LayerNode, depth: number): void => {
    if (f.expert && !expert) return;
    out.push({ field: f, layer, depth });
    for (const c of f.children ?? []) visit(c, layer, depth + 1);
  };
  for (const l of layers) for (const f of l.fields) visit(f, l, 0);
  return out;
}

export function findField(layers: readonly LayerNode[], id: string): Field | null {
  const visit = (f: Field): Field | null => {
    if (f.id === id) return f;
    for (const c of f.children ?? []) {
      const r = visit(c);
      if (r) return r;
    }
    return null;
  };
  for (const l of layers) {
    for (const f of l.fields) {
      const r = visit(f);
      if (r) return r;
    }
  }
  return null;
}
