import type { ByteRange, Fact, Field, LayerId, LayerNode, Msg } from '../model';
import { toHex } from '../bytes/hex';

type Params = Readonly<Record<string, string | number>>;

export function msg(key: string, params?: Params): Msg {
  return params ? { key, params } : { key };
}

export interface FieldOpts {
  readonly expert?: boolean;
  readonly children?: readonly Field[];
  /** Explicit i18n key for the name (otherwise derived from the id). */
  readonly key?: string;
  readonly nameParams?: Params;
}

/** "tls.r3.hs0.ext.2.type" → "field.tls.r.hs.ext.type" */
export function nameKeyFor(id: string): string {
  const segs = id
    .split('.')
    .filter((s) => !/^\d+$/.test(s))
    .map((s) => s.replace(/^(r|hs|dec)\d+$/, '$1'));
  return `field.${segs.join('.')}`;
}

/** Collects fields for one layer while a decoder walks the bytes. */
export class FieldCollector {
  readonly fields: Field[] = [];
  readonly facts: Fact[] = [];

  constructor(
    private readonly bytes: Uint8Array,
    private readonly base = 0,
  ) {}

  /** Creates a field without adding it (for nesting). */
  make(
    id: string,
    name: string,
    start: number,
    end: number,
    display: string,
    meaningKey: string,
    params?: Params,
    opts: FieldOpts = {},
  ): Field {
    const range: ByteRange = [start + this.base, end + this.base];
    const f: Field = {
      id,
      name,
      nameKey: opts.key ?? nameKeyFor(id),
      ...(opts.nameParams ? { nameParams: opts.nameParams } : {}),
      byteRange: range,
      raw: toHex(this.bytes, start, Math.min(end, start + 64), ''),
      display,
      meaning: msg(meaningKey, params),
      expert: opts.expert ?? false,
      ...(opts.children ? { children: opts.children } : {}),
    };
    return f;
  }

  add(
    id: string,
    name: string,
    start: number,
    end: number,
    display: string,
    meaningKey: string,
    params?: Params,
    opts: FieldOpts = {},
  ): Field {
    const f = this.make(id, name, start, end, display, meaningKey, params, opts);
    this.fields.push(f);
    return f;
  }

  fact(label: string, value: string, expert = false): void {
    this.facts.push({ label, value, expert });
  }

  layer(
    id: string,
    name: string,
    layer: LayerId,
    start: number,
    end: number,
    summary: Msg,
    depth = 0,
  ): LayerNode {
    return {
      id,
      depth,
      name,
      layer,
      byteRange: [start + this.base, end + this.base],
      fields: this.fields,
      summary,
      facts: this.facts,
    };
  }
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
