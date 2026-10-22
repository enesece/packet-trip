import { asciiBytes, concatBytes, utf8Bytes } from '../bytes/writer';
import type { Msg, ScenarioConfig } from '../model';
import type { Rng } from '../sim/rng';
import { HtmlTokenizer } from '../browser/html-tokenizer';
import { TreeBuilder, type Discovery } from '../browser/dom';
import { encodeRequest, encodeResponse, type Header } from '../proto/http1';
import {
  FLAG_END_HEADERS,
  FLAG_END_STREAM,
  H2_DATA,
  H2_HEADERS,
  H2_PREFACE,
  encodeFrame,
  headerBlock,
  settingsFrame,
} from '../proto/http2';
import { CT_APPDATA } from '../proto/tls';
import { msg } from '../proto/fields';
import type { SiteDef, SiteResource } from './sites';

export interface HttpRecordInfo {
  readonly part: 'request' | 'response' | 'body' | 'h2';
  readonly resource: string;
  readonly contentType: string;
  readonly bodyOffset: number;
  readonly bodyTotal: number;
  /** HTTP/2 only: stream id → resource path. */
  readonly streams?: Readonly<
    Record<number, { readonly resource: string; readonly contentType: string }>
  >;
}

export interface PlannedRecord {
  /** Content type on the wire (23 for every encrypted TLS 1.3 record). */
  readonly outerType: number;
  readonly encrypted: boolean;
  /** Real content type (inside the encryption for TLS 1.3). */
  readonly innerType: number;
  /** The record's content before encryption. */
  readonly plaintext: Uint8Array;
  readonly label: string;
  readonly http: HttpRecordInfo | null;
}

export interface PlannedWrite {
  readonly side: 'client' | 'server';
  readonly label: string;
  readonly labelMsg: Msg;
  readonly records: readonly PlannedRecord[];
  /** Resources requested (client) or answered (server) by this write. */
  readonly resources: readonly string[];
  /** Server writes: index of the request this answers (−1 for client writes). */
  readonly forRequest: number;
}

export interface AppPlan {
  readonly requests: readonly PlannedWrite[];
  readonly responses: readonly PlannedWrite[];
  /** Resource paths in the order the browser will request them. */
  readonly order: readonly string[];
  /** HTTP/2: which HTML response record (index within responses[0]) triggers each request batch. */
  readonly h2Triggers: readonly number[];
  readonly bodies: ReadonlyMap<string, Uint8Array>;
}

const RECORD_SMALL = 1200;
const RECORD_LARGE = 8000;

export function resourceBody(site: SiteDef, res: SiteResource, rng: Rng): Uint8Array {
  if (res.text !== null) return utf8Bytes(res.text);
  // A fake WOFF2 file: the real signature, then pseudo-random bytes.
  const r = rng.fork(`body:${site.host}${res.path}`);
  return concatBytes([asciiBytes('wOF2'), r.bytes(res.size - 4)]);
}

export function resourceByPath(site: SiteDef, path: string): SiteResource {
  const r = site.resources.find((x) => x.path === path);
  if (!r) throw new Error(`unknown resource ${path}`);
  return r;
}

const PRIORITY: Record<Discovery['kind'], number> = { stylesheet: 0, font: 1, script: 2 };

/** Request order: render-blocking stylesheets first, then fonts, scripts, and non-blocking CSS. */
export function requestPriority(d: Discovery): number {
  if (d.kind === 'stylesheet' && !d.blocking) return 3;
  return PRIORITY[d.kind];
}

function acceptFor(kind: SiteResource['kind']): string {
  switch (kind) {
    case 'document':
      return 'text/html,application/xhtml+xml';
    case 'stylesheet':
      return 'text/css,*/*;q=0.1';
    case 'script':
      return '*/*';
    case 'font':
      return 'font/woff2;q=1.0,*/*;q=0.5';
  }
}

export interface ResponseMeta {
  readonly cache: 'HIT' | 'MISS' | 'NONE';
  readonly age: number;
}

export function cacheMeta(
  _site: SiteDef,
  res: SiteResource,
  viaCdn: boolean,
  rng: Rng,
): ResponseMeta {
  if (!viaCdn) return { cache: 'NONE', age: 0 };
  const age =
    res.cache === 'HIT' ? rng.fork(`age:${res.path}`).int(30, Math.min(res.maxAge - 1, 86000)) : 0;
  return { cache: res.cache, age };
}

function responseHeaders(res: SiteResource, body: Uint8Array, meta: ResponseMeta): Header[] {
  const h: Header[] = [
    ['content-type', res.contentType],
    ['content-length', String(body.length)],
    ['cache-control', `public, max-age=${res.maxAge}`],
    ['age', String(meta.age)],
  ];
  if (meta.cache !== 'NONE') h.push(['x-cache', meta.cache]);
  h.push(['server', meta.cache === 'NONE' ? 'trip-origin' : 'trip-edge']);
  return h;
}

function requestHeaders(site: SiteDef, res: SiteResource): Header[] {
  return [
    ['Host', site.host],
    ['User-Agent', 'PacketTrip/1.0'],
    ['Accept', acceptFor(res.kind)],
    ['Accept-Encoding', 'gzip, br'],
  ];
}

function appRecord(plaintext: Uint8Array, label: string, http: HttpRecordInfo): PlannedRecord {
  return { outerType: CT_APPDATA, encrypted: true, innerType: CT_APPDATA, plaintext, label, http };
}

/** Splits an HTTP/1.1 message into TLS records; small first records let parsing start early. */
function h1Records(
  bytes: Uint8Array,
  headLen: number,
  res: SiteResource,
  bodyLen: number,
  label: string,
  isRequest: boolean,
): PlannedRecord[] {
  const out: PlannedRecord[] = [];
  let pos = 0;
  let i = 0;
  while (pos < bytes.length) {
    const size = i < 8 ? RECORD_SMALL : RECORD_LARGE;
    const end = Math.min(bytes.length, pos + size);
    const first = pos === 0;
    out.push(
      appRecord(bytes.slice(pos, end), first ? label : `${label} (cont.)`, {
        part: first ? (isRequest ? 'request' : 'response') : 'body',
        resource: res.path,
        contentType: res.contentType,
        bodyOffset: Math.max(0, pos - headLen),
        bodyTotal: bodyLen,
      }),
    );
    pos = end;
    i++;
  }
  return out;
}

/** Discovers subresources the way the simulated browser will: per decrypted HTML record. */
export function discoverByRecord(htmlRecords: readonly Uint8Array[]): Discovery[][] {
  const tok = new HtmlTokenizer();
  const tree = new TreeBuilder();
  return htmlRecords.map((chunk) => {
    const ev = tree.process(tok.feedBytes(chunk), 0);
    return ev.flatMap((e) => (e.type === 'discover' ? [e.res] : []));
  });
}

function htmlBodyChunks(records: readonly PlannedRecord[], headLen: number): Uint8Array[] {
  // Body bytes carried by each response record, for discovery.
  const out: Uint8Array[] = [];
  let skip = headLen;
  for (const r of records) {
    const p = r.plaintext;
    if (skip >= p.length) {
      skip -= p.length;
      out.push(new Uint8Array(0));
    } else {
      out.push(p.slice(skip));
      skip = 0;
    }
  }
  return out;
}

export function planApp(site: SiteDef, config: ScenarioConfig, viaCdn: boolean, rng: Rng): AppPlan {
  const bodies = new Map<string, Uint8Array>();
  for (const r of site.resources) bodies.set(r.path, resourceBody(site, r, rng));
  const doc = resourceByPath(site, '/');
  return config.httpVersion === '2'
    ? planH2(site, viaCdn, rng, bodies, doc)
    : planH1(site, viaCdn, rng, bodies, doc);
}

function planH1(
  site: SiteDef,
  viaCdn: boolean,
  rng: Rng,
  bodies: Map<string, Uint8Array>,
  doc: SiteResource,
): AppPlan {
  const requests: PlannedWrite[] = [];
  const responses: PlannedWrite[] = [];
  const add = (res: SiteResource): PlannedRecord[] => {
    const req = encodeRequest({
      method: 'GET',
      path: res.path,
      headers: requestHeaders(site, res),
    });
    requests.push({
      side: 'client',
      label: `GET ${res.path}`,
      labelMsg: msg('w.get', { path: res.path }),
      records: [
        appRecord(req, `GET ${res.path}`, {
          part: 'request',
          resource: res.path,
          contentType: '',
          bodyOffset: 0,
          bodyTotal: 0,
        }),
      ],
      resources: [res.path],
      forRequest: -1,
    });
    const body = bodies.get(res.path) ?? new Uint8Array(0);
    const meta = cacheMeta(site, res, viaCdn, rng);
    const resp = encodeResponse(
      { status: 200, reason: 'OK', headers: responseHeaders(res, body, meta) },
      body,
    );
    const headLen = resp.length - body.length;
    const records = h1Records(resp, headLen, res, body.length, `200 OK ${res.path}`, false);
    responses.push({
      side: 'server',
      label: `200 OK ${res.path}`,
      labelMsg: msg('w.ok', { path: res.path }),
      records,
      resources: [res.path],
      forRequest: requests.length - 1,
    });
    return records;
  };
  add(doc);
  const docResp = responses[0];
  const bodyLen = bodies.get('/')?.length ?? 0;
  const totalLen = docResp ? docResp.records.reduce((n, r) => n + r.plaintext.length, 0) : 0;
  const discovered = discoverByRecord(
    htmlBodyChunks(docResp?.records ?? [], totalLen - bodyLen),
  ).flat();
  const order = [...discovered]
    .map((d, i) => ({ d, i }))
    .sort((a, b) => requestPriority(a.d) - requestPriority(b.d) || a.i - b.i)
    .map(({ d }) => d.url);
  for (const path of order) add(resourceByPath(site, path));
  return { requests, responses, order: ['/', ...order], h2Triggers: [], bodies };
}

function planH2(
  site: SiteDef,
  viaCdn: boolean,
  rng: Rng,
  bodies: Map<string, Uint8Array>,
  doc: SiteResource,
): AppPlan {
  const requests: PlannedWrite[] = [];
  const responses: PlannedWrite[] = [];
  const streams: Record<number, { resource: string; contentType: string }> = {};
  let nextStream = 1;
  const info = (resource: string, contentType: string): HttpRecordInfo => ({
    part: 'h2',
    resource,
    contentType,
    bodyOffset: 0,
    bodyTotal: 0,
    streams,
  });
  const headersFrame = (sid: number, res: SiteResource): Uint8Array =>
    encodeFrame({
      type: H2_HEADERS,
      flags: FLAG_END_HEADERS | FLAG_END_STREAM,
      streamId: sid,
      payload: headerBlock([
        [':method', 'GET'],
        [':scheme', 'https'],
        [':authority', site.host],
        [':path', res.path],
        ['user-agent', 'PacketTrip/1.0'],
        ['accept', acceptFor(res.kind)],
        ['accept-encoding', 'gzip, br'],
      ]),
    });

  /** Server response records for a batch of streams, DATA frames interleaved round-robin. */
  const respond = (
    batch: { sid: number; res: SiteResource }[],
    withSettings: boolean,
  ): PlannedRecord[] => {
    const recs: PlannedRecord[] = [];
    if (withSettings) {
      recs.push(
        appRecord(
          concatBytes([settingsFrame(false), settingsFrame(true)]),
          'SETTINGS',
          info('', ''),
        ),
      );
    }
    const cursors = batch.map(({ sid, res }) => {
      const body = bodies.get(res.path) ?? new Uint8Array(0);
      const meta = cacheMeta(site, res, viaCdn, rng);
      const hdrs: Header[] = [[':status', '200'], ...responseHeaders(res, body, meta)];
      recs.push(
        appRecord(
          encodeFrame({
            type: H2_HEADERS,
            flags: FLAG_END_HEADERS,
            streamId: sid,
            payload: headerBlock(hdrs),
          }),
          `HEADERS 200 ${res.path}`,
          info(res.path, res.contentType),
        ),
      );
      return { sid, res, body, pos: 0 };
    });
    // Serve by priority class (render-blocking CSS first), round-robin within a class.
    const klass = (r: SiteResource): number =>
      r.kind === 'document' ? 0 : r.kind === 'stylesheet' ? 1 : r.kind === 'font' ? 2 : 3;
    const groups = [0, 1, 2, 3].map((k) =>
      cursors.filter((c) => klass(c.res) === k && c.body.length > 0),
    );
    for (const group of groups) {
      let active = group;
      while (active.length > 0) {
        for (const c of active) {
          const end = Math.min(c.body.length, c.pos + RECORD_SMALL);
          const last = end === c.body.length;
          recs.push(
            appRecord(
              encodeFrame({
                type: H2_DATA,
                flags: last ? FLAG_END_STREAM : 0,
                streamId: c.sid,
                payload: c.body.slice(c.pos, end),
              }),
              `DATA ${c.res.path}`,
              info(c.res.path, c.res.contentType),
            ),
          );
          c.pos = end;
        }
        active = active.filter((c) => c.pos < c.body.length);
      }
    }
    return recs;
  };

  const sid0 = nextStream;
  nextStream += 2;
  streams[sid0] = { resource: '/', contentType: doc.contentType };
  requests.push({
    side: 'client',
    label: 'GET / (HTTP/2)',
    labelMsg: msg('w.get', { path: '/' }),
    records: [
      appRecord(
        concatBytes([asciiBytes(H2_PREFACE), settingsFrame(false), headersFrame(sid0, doc)]),
        'GET /',
        info('/', ''),
      ),
    ],
    resources: ['/'],
    forRequest: -1,
  });
  const docRecs = respond([{ sid: sid0, res: doc }], true);
  responses.push({
    side: 'server',
    label: '200 OK /',
    labelMsg: msg('w.ok', { path: '/' }),
    records: docRecs,
    resources: ['/'],
    forRequest: 0,
  });

  // Discovery happens per DATA record of the HTML.
  const htmlChunks = docRecs.map((r) =>
    r.label.startsWith('DATA') ? r.plaintext.slice(9) : new Uint8Array(0),
  );
  const perRecord = discoverByRecord(htmlChunks);
  const triggers: number[] = [];
  const order: string[] = ['/'];
  let first = true;
  perRecord.forEach((found, recIdx) => {
    if (found.length === 0) return;
    const sorted = found
      .map((d, i) => ({ d, i }))
      .sort((a, b) => requestPriority(a.d) - requestPriority(b.d) || a.i - b.i)
      .map(({ d }) => resourceByPath(site, d.url));
    const batch = sorted.map((res) => {
      const sid = nextStream;
      nextStream += 2;
      streams[sid] = { resource: res.path, contentType: res.contentType };
      order.push(res.path);
      return { sid, res };
    });
    const frames = [
      ...(first ? [settingsFrame(true)] : []),
      ...batch.map(({ sid, res }) => headersFrame(sid, res)),
    ];
    first = false;
    const paths = batch.map(({ res }) => res.path);
    requests.push({
      side: 'client',
      label: `GET ${paths.join(', ')}`,
      labelMsg: msg('w.getmany', { paths: paths.join(', ') }),
      records: [
        appRecord(concatBytes(frames), `HEADERS ×${batch.length}`, info(paths.join(', '), '')),
      ],
      resources: paths,
      forRequest: -1,
    });
    // Cache hits go out right away; misses follow once the CDN has them from the origin.
    const k = requests.length - 1;
    const hits = batch.filter(({ res }) => !(viaCdn && res.cache === 'MISS'));
    const misses = batch.filter(({ res }) => viaCdn && res.cache === 'MISS');
    for (const part of [hits, misses]) {
      if (part.length === 0) continue;
      responses.push({
        side: 'server',
        label: `200 OK ×${part.length}`,
        labelMsg: msg('w.okmany', { n: part.length }),
        records: respond(part, false),
        resources: part.map(({ res }) => res.path),
        forRequest: k,
      });
    }
    triggers.push(recIdx);
  });
  return { requests, responses, order, h2Triggers: triggers, bodies };
}

/** Requests the CDN makes to the origin on a cache miss (over a pre-warmed connection). */
export function planOrigin(
  site: SiteDef,
  rng: Rng,
  bodies: ReadonlyMap<string, Uint8Array>,
): { requests: PlannedWrite[]; responses: PlannedWrite[]; paths: string[] } {
  const requests: PlannedWrite[] = [];
  const responses: PlannedWrite[] = [];
  const paths: string[] = [];
  for (const res of site.resources) {
    if (res.cache !== 'MISS') continue;
    paths.push(res.path);
    const req = encodeRequest({
      method: 'GET',
      path: res.path,
      headers: [
        ['Host', site.host],
        ['Via', '1.1 trip-edge'],
        ['Accept-Encoding', 'gzip, br'],
      ],
    });
    requests.push({
      side: 'client',
      label: `GET ${res.path} (to origin)`,
      labelMsg: msg('w.origin.get', { path: res.path }),
      records: [
        appRecord(req, `GET ${res.path}`, {
          part: 'request',
          resource: res.path,
          contentType: '',
          bodyOffset: 0,
          bodyTotal: 0,
        }),
      ],
      resources: [res.path],
      forRequest: -1,
    });
    const body = bodies.get(res.path) ?? new Uint8Array(0);
    const resp = encodeResponse(
      { status: 200, reason: 'OK', headers: responseHeaders(res, body, { cache: 'NONE', age: 0 }) },
      body,
    );
    void rng;
    responses.push({
      side: 'server',
      label: `200 OK ${res.path} (from origin)`,
      labelMsg: msg('w.origin.ok', { path: res.path }),
      records: h1Records(
        resp,
        resp.length - body.length,
        res,
        body.length,
        `200 OK ${res.path}`,
        false,
      ),
      resources: [res.path],
      forRequest: requests.length - 1,
    });
  }
  return { requests, responses, paths };
}
