/**
 * A small, incremental HTML tokenizer for the subset Packet Trip pages use: doctype, comments,
 * start/end tags with attributes, text, and raw-text elements (<style>, <script>).
 * Bytes can be fed in arbitrary chunks; tokens come out as soon as they are complete.
 */

export type HtmlToken =
  | { readonly type: 'doctype'; readonly name: string }
  | {
      readonly type: 'start';
      readonly tag: string;
      readonly attrs: readonly (readonly [string, string])[];
      readonly selfClosing: boolean;
    }
  | { readonly type: 'end'; readonly tag: string }
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'comment'; readonly data: string };

const RAW_TEXT = new Set(['style', 'script', 'title']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n =
        e[1] === 'x' || e[1] === 'X'
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Incremental UTF-8 decoder that keeps incomplete trailing sequences for the next chunk. */
export class Utf8Stream {
  private pending: number[] = [];

  decode(chunk: Uint8Array): string {
    const bytes = this.pending.length ? Uint8Array.from([...this.pending, ...chunk]) : chunk;
    this.pending = [];
    let end = bytes.length;
    // Find an incomplete sequence at the end.
    for (let back = 1; back <= 3 && back <= bytes.length; back++) {
      const c = bytes[bytes.length - back] ?? 0;
      if ((c & 0xc0) === 0x80) continue;
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      if (need > back) {
        end = bytes.length - back;
        this.pending = Array.from(bytes.subarray(end));
      }
      break;
    }
    let s = '';
    let i = 0;
    while (i < end) {
      const c = bytes[i] ?? 0;
      if (c < 0x80) {
        s += String.fromCharCode(c);
        i++;
      } else if (c < 0xe0) {
        s += String.fromCodePoint(((c & 31) << 6) | ((bytes[i + 1] ?? 0) & 63));
        i += 2;
      } else if (c < 0xf0) {
        s += String.fromCodePoint(
          ((c & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) | ((bytes[i + 2] ?? 0) & 63),
        );
        i += 3;
      } else {
        s += String.fromCodePoint(
          ((c & 7) << 18) |
            (((bytes[i + 1] ?? 0) & 63) << 12) |
            (((bytes[i + 2] ?? 0) & 63) << 6) |
            ((bytes[i + 3] ?? 0) & 63),
        );
        i += 4;
      }
    }
    return s;
  }
}

export class HtmlTokenizer {
  private buf = '';
  private rawTag: string | null = null;
  private readonly utf8 = new Utf8Stream();

  /** Feed bytes; returns every token that is now complete. */
  feedBytes(chunk: Uint8Array): HtmlToken[] {
    return this.feed(this.utf8.decode(chunk));
  }

  feed(text: string): HtmlToken[] {
    this.buf += text;
    const out: HtmlToken[] = [];
    for (;;) {
      if (this.rawTag) {
        const close = `</${this.rawTag}`;
        const idx = this.buf.toLowerCase().indexOf(close);
        if (idx < 0) {
          // Emit what we can, keeping a tail that might be the start of the close tag.
          const keep = Math.min(this.buf.length, close.length);
          const emit = this.buf.slice(0, this.buf.length - keep);
          if (emit) out.push({ type: 'text', data: emit });
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        const gt = this.buf.indexOf('>', idx);
        if (gt < 0) {
          if (idx > 0) out.push({ type: 'text', data: this.buf.slice(0, idx) });
          this.buf = this.buf.slice(idx);
          return out;
        }
        if (idx > 0) out.push({ type: 'text', data: this.buf.slice(0, idx) });
        out.push({ type: 'end', tag: this.rawTag });
        this.rawTag = null;
        this.buf = this.buf.slice(gt + 1);
        continue;
      }
      const lt = this.buf.indexOf('<');
      if (lt < 0) {
        if (this.buf) out.push({ type: 'text', data: decodeEntities(this.buf) });
        this.buf = '';
        return out;
      }
      if (lt > 0) {
        out.push({ type: 'text', data: decodeEntities(this.buf.slice(0, lt)) });
        this.buf = this.buf.slice(lt);
      }
      // buf starts with '<'
      if (this.buf.startsWith('<!--')) {
        const end = this.buf.indexOf('-->', 4);
        if (end < 0) return out;
        out.push({ type: 'comment', data: this.buf.slice(4, end) });
        this.buf = this.buf.slice(end + 3);
        continue;
      }
      if (this.buf.length < 4 && '<!--'.startsWith(this.buf)) return out;
      const tagEnd = findTagEnd(this.buf);
      if (tagEnd < 0) return out;
      const raw = this.buf.slice(1, tagEnd);
      this.buf = this.buf.slice(tagEnd + 1);
      if (raw[0] === '!') {
        const m = /^!doctype\s+([^\s>]+)/i.exec(raw);
        out.push({ type: 'doctype', name: (m?.[1] ?? 'html').toLowerCase() });
        continue;
      }
      if (raw[0] === '/') {
        out.push({ type: 'end', tag: raw.slice(1).trim().toLowerCase() });
        continue;
      }
      const tok = parseStartTag(raw);
      out.push(tok);
      if (RAW_TEXT.has(tok.tag) && !tok.selfClosing) this.rawTag = tok.tag;
    }
  }
}

function findTagEnd(s: string): number {
  let q: string | null = null;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseStartTag(raw: string): HtmlToken & { type: 'start' } {
  let s = raw.trim();
  let selfClosing = false;
  if (s.endsWith('/')) {
    selfClosing = true;
    s = s.slice(0, -1).trim();
  }
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  const tag = (m?.[1] ?? '').toLowerCase();
  const attrs: [string, string][] = [];
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const rest = s.slice(tag.length);
  let am: RegExpExecArray | null;
  while ((am = re.exec(rest)) !== null) {
    const name = (am[1] ?? '').toLowerCase();
    const value = am[2] ?? am[3] ?? am[4] ?? '';
    attrs.push([name, decodeEntities(value)]);
  }
  return { type: 'start', tag, attrs, selfClosing };
}
