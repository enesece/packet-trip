import { asciiBytes, bytesToAscii, concatBytes, utf8Decode } from '../bytes/writer';
import { DecodeError } from '../bytes/reader';
import type { Field, LayerNode } from '../model';
import { FieldCollector, msg } from './fields';

export type Header = readonly [name: string, value: string];

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly Header[];
}

export interface HttpResponseHead {
  readonly status: number;
  readonly reason: string;
  readonly headers: readonly Header[];
}

export function encodeRequest(r: HttpRequest): Uint8Array {
  const lines = [
    `${r.method} ${r.path} HTTP/1.1`,
    ...r.headers.map(([n, v]) => `${n}: ${v}`),
    '',
    '',
  ];
  return asciiBytes(lines.join('\r\n'));
}

export function encodeResponse(h: HttpResponseHead, body: Uint8Array): Uint8Array {
  const lines = [
    `HTTP/1.1 ${h.status} ${h.reason}`,
    ...h.headers.map(([n, v]) => `${n}: ${v}`),
    '',
    '',
  ];
  return concatBytes([asciiBytes(lines.join('\r\n')), body]);
}

function findHeaderEnd(b: Uint8Array, start: number, end: number): number {
  for (let i = start; i + 3 < end; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

export function parseHead(text: string): { first: string; headers: Header[] } {
  const lines = text.split('\r\n');
  const first = lines[0] ?? '';
  const headers: Header[] = [];
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c <= 0) throw new DecodeError(`bad header line "${line}"`);
    headers.push([line.slice(0, c), line.slice(c + 1).trim()]);
  }
  return { first, headers };
}

export type HttpPart = 'request' | 'response' | 'body';

export interface HttpBodyContext {
  readonly resource: string;
  readonly contentType: string;
  /** Offset of these bytes within the body, and total body length. */
  readonly bodyOffset: number;
  readonly bodyTotal: number;
}

/**
 * Decodes HTTP/1.1 bytes inside decrypted TLS records. `part` says whether the bytes begin with
 * a request/response head or continue a body (known from the stream, like Wireshark's reassembly).
 */
export function decodeHttp1(
  b: Uint8Array,
  start: number,
  end: number,
  part: HttpPart,
  body: HttpBodyContext | null,
): LayerNode {
  const fc = new FieldCollector(b);
  let bodyStart = start;
  let summary = msg('s.http.body', { resource: body?.resource ?? '' });
  if (part !== 'body') {
    const he = findHeaderEnd(b, start, end);
    if (he < 0) throw new DecodeError('HTTP head is not complete in this record');
    const head = parseHead(bytesToAscii(b.subarray(start, he)));
    let pos = start;
    const firstEnd = pos + head.first.length;
    if (part === 'request') {
      const [method = '', path = '', version = ''] = head.first.split(' ');
      fc.add('http.reqline', 'Request line', pos, firstEnd + 2, head.first, 'm.http.reqline', {
        method,
        path,
        version,
      });
      summary = msg('s.http.req', { method, path });
    } else {
      const sp = head.first.indexOf(' ');
      const status = head.first.slice(sp + 1);
      fc.add('http.status', 'Status line', pos, firstEnd + 2, head.first, 'm.http.status', {
        status,
      });
      summary = msg('s.http.res', { status });
    }
    pos = firstEnd + 2;
    head.headers.forEach(([name, value], i) => {
      const len = name.length + 2 + value.length;
      const key = `m.http.h.${name.toLowerCase()}`;
      fc.add(
        `http.header.${i}`,
        name,
        pos,
        pos + len + 2,
        value,
        HEADER_KEYS.has(name.toLowerCase()) ? key : 'm.http.h.other',
        { name, value },
        { key: 'field.http.header', nameParams: { name } },
      );
      pos += len + 2;
    });
    fc.add('http.end', 'End of headers', pos, pos + 2, '\\r\\n', 'm.http.end', undefined, {
      expert: true,
    });
    bodyStart = he + 4;
    const ct = head.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1];
    const cl = head.headers.find(([n]) => n.toLowerCase() === 'content-length')?.[1];
    if (ct) fc.fact('type', ct);
    if (cl) fc.fact('length', `${cl} B`);
    const host = head.headers.find(([n]) => n.toLowerCase() === 'host')?.[1];
    if (host) fc.fact('host', host);
    const xc = head.headers.find(([n]) => n.toLowerCase() === 'x-cache')?.[1];
    if (xc) fc.fact('x-cache', xc);
  }
  if (bodyStart < end) {
    const n = end - bodyStart;
    const off = part === 'body' ? (body?.bodyOffset ?? 0) : 0;
    const total = body?.bodyTotal ?? n;
    const textual = !(body?.contentType ?? '').startsWith('font/');
    const preview = textual
      ? previewText(utf8Decode(b.subarray(bodyStart, Math.min(end, bodyStart + 120))))
      : `${n} bytes of binary font data`;
    const f: Field = fc.make('http.body', 'Body', bodyStart, end, preview, 'm.http.body', {
      n,
      from: off,
      to: off + n,
      total,
      resource: body?.resource ?? '',
    });
    fc.fields.push(f);
    fc.fact('body', `${n} B`);
  }
  return fc.layer('http', 'HTTP/1.1', 'application', start, end, summary);
}

function previewText(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

const HEADER_KEYS = new Set([
  'host',
  'user-agent',
  'accept',
  'accept-encoding',
  'content-type',
  'content-length',
  'cache-control',
  'age',
  'x-cache',
  'server',
  'connection',
]);

/** Incremental HTTP/1.1 response parser used by the simulated browser. */
export class Http1ResponseParser {
  private buf: Uint8Array = new Uint8Array(0);
  private head: HttpResponseHead | null = null;
  private bodyLen = 0;
  private bodyRead = 0;

  get headDone(): boolean {
    return this.head !== null;
  }

  get done(): boolean {
    return this.head !== null && this.bodyRead >= this.bodyLen;
  }

  get response(): HttpResponseHead | null {
    return this.head;
  }

  get contentLength(): number {
    return this.bodyLen;
  }

  /** Feeds bytes; returns the newly available body chunk (may be empty). */
  feed(chunk: Uint8Array): { body: Uint8Array; headNow: boolean; leftover: Uint8Array } {
    let headNow = false;
    let data = chunk;
    if (!this.head) {
      this.buf = concatBytes([this.buf, chunk]);
      const he = findHeaderEnd(this.buf, 0, this.buf.length);
      if (he < 0) return { body: new Uint8Array(0), headNow, leftover: new Uint8Array(0) };
      const head = parseHead(bytesToAscii(this.buf.subarray(0, he)));
      const [, code = '0', ...reason] = head.first.split(' ');
      this.head = { status: Number(code), reason: reason.join(' '), headers: head.headers };
      const cl = head.headers.find(([n]) => n.toLowerCase() === 'content-length');
      this.bodyLen = cl ? Number(cl[1]) : 0;
      data = this.buf.subarray(he + 4);
      this.buf = new Uint8Array(0);
      headNow = true;
    }
    const take = Math.min(data.length, this.bodyLen - this.bodyRead);
    this.bodyRead += take;
    return { body: data.slice(0, take), headNow, leftover: data.slice(take) };
  }
}
