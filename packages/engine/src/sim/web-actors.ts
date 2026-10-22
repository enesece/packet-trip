import type {
  DisplayItem,
  LayoutBox,
  Msg,
  NodeId,
  PipelineStep,
  ResourceTiming,
  StopId,
} from '../model';
import type { CryptoMaterial, SealedWrite } from '../crypto/types';
import { msg } from '../proto/fields';
import { Http1ResponseParser } from '../proto/http1';
import { FLAG_END_STREAM, H2FrameReader, H2_DATA, H2_HEADERS } from '../proto/http2';
import { HtmlTokenizer } from '../browser/html-tokenizer';
import { TreeBuilder, type Discovery } from '../browser/dom';
import { Cssom } from '../browser/cssom';
import { buildRenderTree } from '../browser/style';
import { layout, type LayoutResult } from '../browser/layout';
import { layoutBoxes, paint } from '../browser/paint';
import { resolveFamily, type TextMeasurer } from '../browser/measure';
import { resourceByPath } from '../content/plan';
import type { WriteMeta } from '../net/tcp-conn';
import { Connection, RecordReader } from './connection';
import type { World } from './world';
import { utf8Decode } from '../bytes/writer';

export const VIEWPORT = { w: 600, h: 420 } as const;

export interface RenderFrame {
  readonly tUs: number;
  readonly boxes: readonly LayoutBox[];
  readonly display: readonly DisplayItem[];
  readonly height: number;
  readonly reason: 'first' | 'font' | 'css';
}

interface MutableTiming {
  url: string;
  kind: ResourceTiming['kind'];
  requestUs: number;
  firstByteUs: number;
  doneUs: number;
  bytes: number;
  renderBlocking: boolean;
  cache: ResourceTiming['cache'];
}

interface IncomingRecord {
  readonly kind: 'hs' | 'app';
  readonly writeIdx: number;
  readonly recIdx: number;
  readonly last: boolean;
}

function incomingPlan(
  hs: readonly SealedWrite[],
  app: readonly SealedWrite[],
  side: 'client' | 'server',
): IncomingRecord[] {
  const out: IncomingRecord[] = [];
  hs.forEach((w, wi) => {
    if (w.side !== side) return;
    w.records.forEach((_, ri) =>
      out.push({ kind: 'hs', writeIdx: wi, recIdx: ri, last: ri === w.records.length - 1 }),
    );
  });
  app.forEach((w, wi) =>
    w.records.forEach((_, ri) =>
      out.push({ kind: 'app', writeIdx: wi, recIdx: ri, last: ri === w.records.length - 1 }),
    ),
  );
  return out;
}

const STORY_HS: Record<'1.2' | '1.3', readonly string[]> = {
  '1.3': ['story.ch', 'story.sflight13', 'story.cfin13'],
  '1.2': ['story.ch', 'story.sflight12', 'story.cflight12', 'story.sfin12'],
};

/** The browser on the laptop and the web server(s) it talks to. */
export class WebActors {
  readonly marks = {
    dnsDoneUs: null as number | null,
    connectedUs: null as number | null,
    tlsDoneUs: null as number | null,
    firstByteUs: null as number | null,
    htmlDoneUs: null as number | null,
    firstPaintUs: null as number | null,
    loadUs: null as number | null,
    dclUs: null as number | null,
    fontSwapUs: null as number | null,
    cssReadyUs: null as number | null,
  };
  readonly resources = new Map<string, MutableTiming>();
  readonly frames: RenderFrame[] = [];
  readonly pipelineTimes: Record<PipelineStep, number | null> = {
    html: null,
    css: null,
    style: null,
    layout: null,
    paint: null,
    composite: null,
  };
  htmlStartUs: number | null = null;
  readonly tokenizer = new HtmlTokenizer();
  readonly tree = new TreeBuilder();
  readonly cssom = new Cssom();
  htmlBytesParsed = 0;
  readonly connections: Connection[] = [];

  private conn: Connection | null = null;
  private serverNode: NodeId = 'cdn';
  private readonly viaCdn: boolean;
  private readonly blocking = new Set<string>();
  private readonly webFonts = new Set<string>();
  private readonly fontsLoaded = new Set<string>();
  private readonly deferred: string[] = [];
  private scriptsRun = 0;
  private rendering = false;
  private renderAgain: RenderFrame['reason'] | null = null;
  private painted = false;
  private docDone = false;
  private dcl = false;
  private origin: OriginLink | null = null;
  private discovered: Discovery[] = [];

  constructor(
    private readonly w: World,
    private readonly mat: CryptoMaterial,
    private readonly measure: TextMeasurer,
  ) {
    this.viaCdn = w.config.cdn && w.site.cdn;
  }

  get serverAddress(): string {
    return this.w.nodes[this.viaCdn ? 'cdn' : 'origin'].address;
  }

  get isPainted(): boolean {
    return this.painted;
  }

  get isFontLoaded(): boolean {
    return this.fontsLoaded.size > 0;
  }

  /** Called once DNS has produced the server address. */
  connect(): void {
    const w = this.w;
    const main = this.mat.main;
    this.serverNode = this.viaCdn ? 'cdn' : 'origin';
    if (this.viaCdn && this.mat.origin.paths.length > 0)
      this.origin = new OriginLink(
        w,
        this.mat,
        () => this.connections.length + 1,
        (c) => this.connections.push(c),
      );
    const fromServer = incomingPlan(main.handshake, main.responses, 'server');
    const fromClient = incomingPlan(main.handshake, main.requests, 'client');
    const clientReader = new RecordReader();
    const serverReader = new RecordReader();
    let clientRec = 0;
    let serverRec = 0;
    const h2Client = new H2FrameReader(false);
    let h1Parser: Http1ResponseParser | null = null;

    const conn = new Connection(w, {
      id: 1,
      label: `${this.w.nodes.laptop.address} ↔ ${this.serverAddress}:443`,
      clientNode: 'laptop',
      serverNode: this.serverNode,
      serverPort: 443,
      tls: main.tls,
      client: {
        onEstablished: () => {
          this.marks.connectedUs = w.now;
          this.writeHs('client', 0);
        },
        onData: (data) => {
          for (const rec of clientReader.feed(data)) {
            const info = fromServer[clientRec++];
            if (!info) continue;
            this.onServerRecord(
              info,
              rec,
              h2Client,
              () => h1Parser,
              (p) => (h1Parser = p),
            );
          }
        },
        onPeerFin: () => undefined,
      },
      server: {
        onEstablished: () => undefined,
        onData: (data) => {
          for (const _rec of serverReader.feed(data)) {
            const info = fromClient[serverRec++];
            if (!info || !info.last) continue;
            if (info.kind === 'hs') {
              const next = info.writeIdx + 1;
              if (main.handshake[next]) {
                w.after(main.tls === '1.3' ? 800 : 300, () => {
                  w.log(
                    'state',
                    'security',
                    this.serverNode,
                    msg(next === 1 ? 'ev.tls.server.flight' : 'ev.tls.server.finish'),
                  );
                  this.writeHs('server', next);
                });
              }
            } else {
              this.handleRequest(info.writeIdx);
            }
          }
        },
        onPeerFin: () => {
          w.after(100, () => conn.server.close());
        },
      },
    });
    this.conn = conn;
    this.connections.unshift(conn);
    w.log('state', 'transport', 'laptop', msg('ev.connect', { address: this.serverAddress }));
    conn.server.listen();
    conn.client.connect();
  }

  private writeMeta(kind: 'hs' | 'req' | 'res', idx: number, write: SealedWrite): WriteMeta {
    const main = this.mat.main;
    const encrypted = write.records.some((r) => r.encrypted);
    let stop: StopId | null;
    let story: Msg;
    if (kind === 'hs') {
      stop = 'tls';
      story = msg(STORY_HS[main.tls][idx] ?? 'story.tls');
    } else if (kind === 'req') {
      stop = idx === 0 ? 'request' : 'render';
      story = msg(
        idx === 0 ? 'story.get.doc' : main.http === '2' ? 'story.h2.get' : 'story.get.sub',
        { paths: write.resources.join(', ') },
      );
    } else {
      stop = idx === 0 ? 'response' : 'render';
      story = msg(
        idx === 0 ? 'story.resp.doc' : main.http === '2' ? 'story.h2.resp' : 'story.resp.sub',
        { paths: write.resources.join(', ') },
      );
    }
    return {
      label: write.label,
      labelMsg: write.labelMsg,
      proto: kind === 'hs' ? 'TLS' : main.http === '2' ? 'HTTP/2' : 'HTTP',
      topLayer: kind === 'hs' ? 'security' : 'application',
      encrypted,
      stop,
      story,
    };
  }

  private writeHs(side: 'client' | 'server', idx: number): void {
    const write = this.mat.main.handshake[idx];
    if (!write || !this.conn) return;
    this.conn.writeSealed(side, write, this.writeMeta('hs', idx, write));
  }

  private startApp(): void {
    this.marks.tlsDoneUs = this.w.now;
    this.w.log(
      'state',
      'security',
      'laptop',
      msg('ev.tls.done', { version: this.mat.main.tls === '1.3' ? 'TLS 1.3' : 'TLS 1.2' }),
    );
    this.sendRequest(0);
  }

  private sendRequest(k: number): void {
    const write = this.mat.main.requests[k];
    if (!write || !this.conn) return;
    for (const path of write.resources) {
      const res = resourceByPath(this.w.site, path);
      const disc = this.discovered.find((d) => d.url === path);
      this.resources.set(path, {
        url: path,
        kind: res.kind,
        requestUs: this.w.now,
        firstByteUs: -1,
        doneUs: -1,
        bytes: 0,
        renderBlocking:
          res.kind === 'document' || (disc ? disc.blocking && disc.kind === 'stylesheet' : false),
        cache: this.viaCdn ? res.cache : 'NONE',
      });
    }
    this.conn.writeSealed('client', write, this.writeMeta('req', k, write));
  }

  private onServerRecord(
    info: IncomingRecord,
    _bytes: Uint8Array,
    h2: H2FrameReader,
    getH1: () => Http1ResponseParser | null,
    setH1: (p: Http1ResponseParser | null) => void,
  ): void {
    const w = this.w;
    const main = this.mat.main;
    if (info.kind === 'hs') {
      if (!info.last) return;
      if (main.tls === '1.3') {
        w.after(400, () => {
          w.log('state', 'security', 'laptop', msg('ev.tls.verify'));
          this.writeHs('client', 2);
          this.startApp();
        });
      } else if (info.writeIdx === 1) {
        w.after(400, () => {
          w.log('state', 'security', 'laptop', msg('ev.tls.verify12'));
          this.writeHs('client', 2);
        });
      } else if (info.writeIdx === 3) {
        this.startApp();
      }
      return;
    }
    // Application data: "decrypt" (the plaintext is known to the simulation).
    const write = main.responses[info.writeIdx];
    const rec = write?.records[info.recIdx];
    if (!write || !rec) return;
    const plaintext = rec.plaintext;
    if (main.http === '1.1') {
      const path = write.resources[0] ?? '/';
      let parser = getH1();
      if (info.recIdx === 0 || !parser) {
        parser = new Http1ResponseParser();
        setH1(parser);
      }
      const r = parser.feed(plaintext);
      const t = this.resources.get(path);
      if (r.headNow && t && t.firstByteUs < 0) {
        t.firstByteUs = w.now;
        if (path === '/') this.marks.firstByteUs = w.now;
        w.log(
          'state',
          'application',
          'laptop',
          msg('ev.http.head', { path, status: `${parser.response?.status ?? 200}` }),
        );
      }
      if (t) t.bytes += r.body.length;
      if (path === '/' && r.body.length > 0) this.htmlChunk(r.body);
      if (parser.done && info.last) {
        this.resourceDone(path);
        const nxt = info.writeIdx + 1;
        if (main.requests[nxt]) this.sendRequest(nxt);
      }
      return;
    }
    // HTTP/2
    for (const f of h2.feed(plaintext)) {
      const streams = rec.http?.streams ?? {};
      const path = streams[f.streamId]?.resource;
      if (!path) continue;
      const t = this.resources.get(path);
      if (f.type === H2_HEADERS && t && t.firstByteUs < 0) {
        t.firstByteUs = w.now;
        if (path === '/') this.marks.firstByteUs = w.now;
        w.log('state', 'application', 'laptop', msg('ev.http.head', { path, status: '200' }));
      }
      if (f.type === H2_DATA) {
        if (t) t.bytes += f.payload.length;
        if (path === '/') this.htmlChunk(f.payload);
      }
      if (f.flags & FLAG_END_STREAM) this.resourceDone(path);
    }
    if (info.writeIdx === 0) {
      const trig = main.h2Triggers.indexOf(info.recIdx);
      if (trig >= 0) this.sendRequest(trig + 1);
    }
  }

  // ------------------------------------------------------------------ server side

  private responsesWritten = 0;
  private readyResponses = new Set<number>();

  private handleRequest(k: number): void {
    const w = this.w;
    const req = this.mat.main.requests[k];
    if (!req) return;
    this.mat.main.responses.forEach((resp, idx) => {
      if (resp.forRequest !== k) return;
      const isDoc = resp.resources.includes('/');
      const misses =
        this.serverNode === 'cdn'
          ? resp.resources.filter((p) => resourceByPath(w.site, p).cache === 'MISS')
          : [];
      if (misses.length > 0 && this.origin) {
        w.log('state', 'application', 'cdn', msg('ev.cdn.miss', { paths: misses.join(', ') }));
        this.origin.fetch(misses, () => w.after(300, () => this.responseReady(idx)));
        return;
      }
      if (this.serverNode === 'cdn') {
        w.log(
          'state',
          'application',
          'cdn',
          msg('ev.cdn.hit', { paths: resp.resources.join(', ') }),
        );
      }
      const think = isDoc ? w.site.htmlThinkMs * 1000 : this.serverNode === 'cdn' ? 300 : 1000;
      if (isDoc) {
        w.log(
          'state',
          'application',
          this.serverNode,
          msg('ev.server.think', { ms: w.site.htmlThinkMs }),
        );
      }
      w.after(think, () => this.responseReady(idx));
    });
  }

  private responseReady(k: number): void {
    this.readyResponses.add(k);
    while (this.readyResponses.has(this.responsesWritten)) {
      const idx = this.responsesWritten;
      this.readyResponses.delete(idx);
      const write = this.mat.main.responses[idx];
      if (write && this.conn)
        this.conn.writeSealed('server', write, this.writeMeta('res', idx, write));
      this.responsesWritten++;
    }
  }

  // ------------------------------------------------------------------ rendering

  private htmlChunk(chunk: Uint8Array): void {
    const w = this.w;
    if (this.htmlStartUs === null) this.htmlStartUs = w.now;
    this.htmlBytesParsed += chunk.length;
    const tokens = this.tokenizer.feedBytes(chunk);
    const events = this.tree.process(tokens, w.now);
    const nodes = events.filter((e) => e.type === 'node').length;
    w.log(
      'parse',
      'browser',
      'laptop',
      msg('ev.html.parse', { bytes: chunk.length, nodes, tokens: tokens.length }),
    );
    for (const e of events) {
      if (e.type === 'discover') {
        this.discovered.push(e.res);
        if (e.res.kind === 'stylesheet' && e.res.blocking) this.blocking.add(e.res.url);
        if (e.res.kind === 'script' && !e.res.blocking) this.deferred.push(e.res.url);
        w.log(
          'parse',
          'browser',
          'laptop',
          msg(`ev.discover.${e.res.kind}${e.res.blocking ? '.blocking' : ''}`, { url: e.res.url }),
        );
      } else if (e.type === 'inline-style') {
        const n = this.cssom.add(e.css, 'inline <style>');
        this.noteFontFaces(e.css);
        w.log('parse', 'browser', 'laptop', msg('ev.css.inline', { rules: n }));
      } else if (e.type === 'end-of-document') {
        this.docDone = true;
        this.pipelineTimes.html = w.now;
        w.log('parse', 'browser', 'laptop', msg('ev.html.done'));
        if (this.blocking.size === 0 && this.pipelineTimes.css === null)
          this.pipelineTimes.css = w.now;
        w.after(50, () => {
          this.runScripts();
          this.maybeRender();
        });
      }
    }
  }

  private noteFontFaces(css: string): void {
    const re = /@font-face\s*{[^}]*font-family:\s*["']?([^;"'}]+)["']?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) if (m[1]) this.webFonts.add(m[1].trim());
  }

  private resourceDone(path: string): void {
    const w = this.w;
    const t = this.resources.get(path);
    if (t && t.doneUs < 0) t.doneUs = w.now;
    w.log('state', 'application', 'laptop', msg('ev.res.done', { path, bytes: t?.bytes ?? 0 }));
    if (path === '/') {
      this.marks.htmlDoneUs = w.now;
      return;
    }
    const res = resourceByPath(w.site, path);
    if (res.kind === 'stylesheet') {
      w.after(300, () => {
        const text = utf8Decode(this.mat.main.bodies.get(path) ?? new Uint8Array(0));
        const n = this.cssom.add(text, path);
        this.noteFontFaces(text);
        const wasBlocking = this.blocking.delete(path);
        w.log('parse', 'browser', 'laptop', msg('ev.css.parsed', { url: path, rules: n }));
        if (wasBlocking && this.blocking.size === 0) {
          this.pipelineTimes.css = w.now;
          this.marks.cssReadyUs = w.now;
        }
        if (this.painted) this.requestRender('css');
        else this.maybeRender();
        this.checkLoad();
      });
    } else if (res.kind === 'font') {
      w.after(150, () => {
        if (path === '/font.woff2') this.fontsLoaded.add('Trip Sans');
        w.log('parse', 'browser', 'laptop', msg('ev.font.loaded', { url: path }));
        if (this.painted && path === '/font.woff2') this.requestRender('font');
        this.checkLoad();
      });
    } else if (res.kind === 'script') {
      this.runScripts();
    }
  }

  private scriptRunning = false;

  private runScripts(): void {
    const w = this.w;
    if (!this.docDone || this.scriptRunning) return;
    const next = this.deferred[this.scriptsRun];
    if (next === undefined) {
      if (!this.dcl) {
        this.dcl = true;
        this.marks.dclUs = w.now;
        w.log('state', 'browser', 'laptop', msg('ev.dcl'));
        this.checkLoad();
      }
      return;
    }
    const t = this.resources.get(next);
    if (!t || t.doneUs < 0) return;
    this.scriptRunning = true;
    const cost = 600 + Math.round((t.bytes / 20_000) * 1000);
    w.after(cost, () => {
      this.scriptRunning = false;
      this.scriptsRun++;
      w.log(
        'parse',
        'browser',
        'laptop',
        msg('ev.script.run', { url: next, ms: (cost / 1000).toFixed(1) }),
      );
      this.runScripts();
    });
  }

  private maybeRender(): void {
    if (this.painted || this.rendering || !this.docDone || this.blocking.size > 0) return;
    this.requestRender('first');
  }

  private requestRender(reason: RenderFrame['reason']): void {
    if (this.rendering) {
      this.renderAgain = reason;
      return;
    }
    const w = this.w;
    this.rendering = true;
    const first = !this.painted;
    let lay: LayoutResult | null = null;
    let renderRoot: ReturnType<typeof buildRenderTree> = null;
    w.after(250, () => {
      renderRoot = buildRenderTree(this.tree.document, this.cssom);
      if (first) this.pipelineTimes.style = w.now;
      w.log(
        'parse',
        'browser',
        'laptop',
        msg(reason === 'font' ? 'ev.style.font' : 'ev.style', { rules: this.cssom.ruleCount }),
      );
      w.after(450, () => {
        if (renderRoot) {
          lay = layout(renderRoot, VIEWPORT.w, {
            measure: this.measure,
            family: (stack) => resolveFamily(stack, this.webFonts, this.fontsLoaded),
          });
        }
        if (first) this.pipelineTimes.layout = w.now;
        w.log(
          'paint',
          'browser',
          'laptop',
          msg('ev.layout', {
            boxes: lay ? lay.blocks.length + lay.texts.length : 0,
            height: Math.round(lay?.height ?? 0),
          }),
        );
        w.after(300, () => {
          const display = lay ? paint(lay, VIEWPORT.w, VIEWPORT.h) : [];
          if (first) this.pipelineTimes.paint = w.now;
          w.log('paint', 'browser', 'laptop', msg('ev.paint', { items: display.length }));
          w.after(200, () => {
            this.frames.push({
              tUs: w.now,
              boxes: lay ? layoutBoxes(lay) : [],
              display,
              height: lay?.height ?? 0,
              reason,
            });
            if (first) {
              this.pipelineTimes.composite = w.now;
              this.marks.firstPaintUs = w.now;
              this.painted = true;
              w.log('paint', 'browser', 'laptop', msg('ev.firstpaint'));
            } else {
              if (reason === 'font') this.marks.fontSwapUs = w.now;
              w.log(
                'paint',
                'browser',
                'laptop',
                msg(reason === 'font' ? 'ev.repaint.font' : 'ev.repaint.css'),
              );
            }
            this.rendering = false;
            const again = this.renderAgain;
            this.renderAgain = null;
            if (again) this.requestRender(again);
            else if (
              this.fontsLoaded.size > 0 &&
              first &&
              this.webFonts.size > 0 &&
              this.marks.fontSwapUs === null
            ) {
              // The font arrived while we were painting with the fallback.
              this.requestRender('font');
            } else this.checkLoad();
          });
        });
      });
    });
  }

  private loaded = false;

  private checkLoad(): void {
    if (this.loaded || !this.dcl || !this.painted || this.rendering) return;
    for (const t of this.resources.values()) if (t.doneUs < 0) return;
    if (this.mat.main.order.some((p) => !this.resources.has(p))) return;
    if (this.blocking.size > 0) return;
    const w = this.w;
    this.loaded = true;
    this.marks.loadUs = w.now;
    w.log('state', 'browser', 'laptop', msg('ev.load'));
    w.after(20_000, () => {
      w.log('state', 'transport', 'laptop', msg('ev.close'));
      this.conn?.client.close();
    });
  }

  timings(): ResourceTiming[] {
    return [...this.resources.values()].map((t) => ({ ...t }));
  }
}

/** The CDN's pre-warmed, already-encrypted keep-alive connection to the origin. */
class OriginLink {
  private readonly conn: Connection;
  private queue: { paths: string[]; done: () => void }[] = [];
  private busy = false;
  private respIdx = -1;
  private respRecs = 0;
  private onResp: (() => void) | null = null;

  constructor(
    w: World,
    private readonly mat: CryptoMaterial,
    nextId: () => number,
    register: (c: Connection) => void,
  ) {
    const o = mat.origin;
    const cdnReader = new RecordReader();
    const originReader = new RecordReader();
    let reqIdx = 0;
    this.conn = new Connection(w, {
      id: nextId(),
      label: `${w.nodes.cdn.address} ↔ ${w.nodes.origin.address}:443 (keep-alive)`,
      clientNode: 'cdn',
      serverNode: 'origin',
      serverPort: 443,
      tls: '1.3',
      client: {
        onEstablished: () => undefined,
        onData: (data) => {
          for (const _r of cdnReader.feed(data)) {
            this.respRecs++;
            const resp = o.responses[this.respIdx];
            if (resp && this.respRecs === resp.records.length) {
              const cb = this.onResp;
              this.onResp = null;
              cb?.();
            }
          }
        },
        onPeerFin: () => undefined,
      },
      server: {
        onEstablished: () => undefined,
        onData: (data) => {
          for (const _r of originReader.feed(data)) {
            const k = reqIdx++;
            const path = o.paths[k] ?? '/';
            const think = path === '/' ? w.site.htmlThinkMs * 1000 : 1000;
            w.log('state', 'application', 'origin', msg('ev.server.think', { ms: think / 1000 }));
            w.after(think, () => {
              const resp = o.responses[k];
              if (resp) this.conn.writeSealed('server', resp, this.meta(resp, 'res'));
            });
          }
        },
        onPeerFin: () => undefined,
      },
    });
    register(this.conn);
    this.conn.client.establishWith(this.conn.server.isn, 9);
    this.conn.server.establishWith(this.conn.client.isn, 7);
  }

  private meta(write: SealedWrite, kind: 'req' | 'res'): WriteMeta {
    return {
      label: write.label,
      labelMsg: write.labelMsg,
      proto: 'HTTP',
      topLayer: 'application',
      encrypted: true,
      stop: null,
      story: msg(kind === 'req' ? 'story.origin.get' : 'story.origin.resp', {
        paths: write.resources.join(', '),
      }),
    };
  }

  fetch(paths: string[], done: () => void): void {
    this.queue.push({ paths: [...paths], done });
    this.pump();
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.queue[0];
    if (!job) return;
    const path = job.paths.shift();
    if (path === undefined) {
      this.queue.shift();
      job.done();
      this.pump();
      return;
    }
    const k = this.mat.origin.paths.indexOf(path);
    const req = this.mat.origin.requests[k];
    if (!req) {
      this.pump();
      return;
    }
    this.busy = true;
    this.respIdx = k;
    this.respRecs = 0;
    this.onResp = () => {
      this.busy = false;
      this.pump();
    };
    this.conn.writeSealed('client', req, this.meta(req, 'req'));
  }
}
