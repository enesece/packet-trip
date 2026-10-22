import type { DomNode } from '../model';
import type { HtmlToken } from './html-tokenizer';

/** Mutable DOM used inside the engine; `freeze` produces the plain DomNode snapshots. */
export interface MNode {
  id: number;
  kind: DomNode['kind'];
  tag: string;
  attrs: [string, string][];
  text: string;
  children: MNode[];
  parent: MNode | null;
  createdUs: number;
}

const VOID = new Set(['link', 'meta', 'br', 'img', 'hr', 'input']);

export interface Discovery {
  readonly kind: 'stylesheet' | 'script' | 'font';
  readonly url: string;
  readonly blocking: boolean;
  readonly nodeId: number;
}

export type TreeEvent =
  | { readonly type: 'node'; readonly node: MNode }
  | { readonly type: 'discover'; readonly res: Discovery }
  | { readonly type: 'inline-style'; readonly css: string; readonly nodeId: number }
  | { readonly type: 'end-of-document' };

export function attr(n: MNode | DomNode, name: string): string | null {
  for (const [k, v] of n.attrs) if (k === name) return v;
  return null;
}

/** Simplified tree construction: enough for well-formed documents in our subset. */
export class TreeBuilder {
  readonly document: MNode;
  private stack: MNode[];
  private nextId = 1;
  private styleBuf: string | null = null;
  private styleNode = 0;
  done = false;

  constructor() {
    this.document = this.make('document', '#document', [], 0);
    this.stack = [this.document];
  }

  private make(kind: MNode['kind'], tag: string, attrs: [string, string][], t: number): MNode {
    return {
      id: this.nextId++,
      kind,
      tag,
      attrs,
      text: '',
      children: [],
      parent: null,
      createdUs: t,
    };
  }

  private get current(): MNode {
    return this.stack[this.stack.length - 1] ?? this.document;
  }

  private append(n: MNode): void {
    n.parent = this.current;
    this.current.children.push(n);
  }

  process(tokens: readonly HtmlToken[], tUs: number): TreeEvent[] {
    const ev: TreeEvent[] = [];
    for (const tok of tokens) {
      switch (tok.type) {
        case 'doctype': {
          const n = this.make('doctype', `!doctype ${tok.name}`, [], tUs);
          this.append(n);
          ev.push({ type: 'node', node: n });
          break;
        }
        case 'comment':
          break;
        case 'text': {
          if (this.styleBuf !== null) {
            this.styleBuf += tok.data;
            break;
          }
          const cur = this.current;
          const inBody = this.stack.some((s) => s.tag === 'body');
          const inTitle = cur.tag === 'title' || cur.tag === 'script';
          if (!inBody && !inTitle && tok.data.trim() === '') break;
          const last = cur.children[cur.children.length - 1];
          if (last && last.kind === 'text') {
            last.text += tok.data;
          } else {
            if (
              tok.data.trim() === '' &&
              (cur.tag === 'body' || cur.tag === 'html' || cur.tag === 'div')
            ) {
              // Inter-element whitespace in block containers is irrelevant for our layout.
              break;
            }
            const n = this.make('text', '#text', [], tUs);
            n.text = tok.data;
            this.append(n);
            ev.push({ type: 'node', node: n });
          }
          break;
        }
        case 'start': {
          const n = this.make(
            'element',
            tok.tag,
            tok.attrs.map(([a, b]) => [a, b]),
            tUs,
          );
          this.append(n);
          ev.push({ type: 'node', node: n });
          if (!VOID.has(tok.tag) && !tok.selfClosing) this.stack.push(n);
          if (tok.tag === 'style') {
            this.styleBuf = '';
            this.styleNode = n.id;
          }
          if (tok.tag === 'link') {
            const rel = (attr(n, 'rel') ?? '').toLowerCase();
            const href = attr(n, 'href');
            if (href && rel === 'stylesheet') {
              const media = (attr(n, 'media') ?? 'all').toLowerCase();
              ev.push({
                type: 'discover',
                res: { kind: 'stylesheet', url: href, blocking: media !== 'print', nodeId: n.id },
              });
            } else if (href && rel === 'preload' && attr(n, 'as') === 'font') {
              ev.push({
                type: 'discover',
                res: { kind: 'font', url: href, blocking: false, nodeId: n.id },
              });
            }
          }
          if (tok.tag === 'script') {
            const src = attr(n, 'src');
            if (src)
              ev.push({
                type: 'discover',
                res: {
                  kind: 'script',
                  url: src,
                  blocking: attr(n, 'defer') === null,
                  nodeId: n.id,
                },
              });
          }
          break;
        }
        case 'end': {
          if (tok.tag === 'style' && this.styleBuf !== null) {
            const styleEl = this.current;
            const t = this.make('text', '#text', [], tUs);
            t.text = this.styleBuf;
            t.parent = styleEl;
            styleEl.children.push(t);
            ev.push({ type: 'inline-style', css: this.styleBuf, nodeId: this.styleNode });
            this.styleBuf = null;
          }
          for (let i = this.stack.length - 1; i > 0; i--) {
            if (this.stack[i]?.tag === tok.tag) {
              this.stack.length = i;
              break;
            }
          }
          if (tok.tag === 'html') {
            this.done = true;
            ev.push({ type: 'end-of-document' });
          }
          break;
        }
      }
    }
    return ev;
  }
}

export function freeze(n: MNode, upToUs = Number.POSITIVE_INFINITY): DomNode {
  return {
    id: n.id,
    kind: n.kind,
    tag: n.tag,
    attrs: n.attrs.map(([a, b]) => [a, b] as const),
    text: n.text,
    children: n.children.filter((c) => c.createdUs <= upToUs).map((c) => freeze(c, upToUs)),
    createdUs: n.createdUs,
  };
}

export function walk(n: MNode, fn: (n: MNode) => void): void {
  fn(n);
  for (const c of n.children) walk(c, fn);
}
