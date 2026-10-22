import type {
  HopTime,
  LayerId,
  Msg,
  NodeId,
  ScenarioConfig,
  SimEvent,
  StopId,
  EventKind,
} from '../model';
import type { TcpHeader } from '../proto/tcp';
import type { UdpHeader } from '../proto/udp';
import type { SealedRecord } from '../crypto/types';
import { msg } from '../proto/fields';
import { VirtualClock } from './clock';
import { EventQueue } from './queue';
import { createRng, type Rng } from './rng';
import { Links } from '../net/link';
import { buildLinks, buildNodes, route, type LinkDef, type NodeDef } from '../net/topology';
import type { SiteDef } from '../content/sites';
import { IPV4_HEADER_LEN, PROTO_TCP, PROTO_UDP } from '../proto/ipv4';
import { ETHERNET_HEADER_LEN } from '../proto/ethernet';

export const MAX_PACKET_DETAILS = 2000;

/** A node reference inside message params; the UI swaps it for the translated node name. */
export const nodeRef = (id: NodeId): string => `@node:${id}`;

export interface RecordSpan {
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly rec: SealedRecord;
}

export interface TlsSegCtx {
  readonly spans: readonly RecordSpan[];
  readonly streamOffset: number;
  readonly version: '1.2' | '1.3';
}

export interface TcpCtx {
  readonly isnSrc: number;
  readonly isnDst: number | null;
  readonly wscaleSrc: number;
}

export interface PacketMeta {
  readonly proto: string;
  readonly name: string;
  readonly nameMsg: Msg;
  readonly topLayer: LayerId;
  readonly flow: 'dns' | 'tcp';
  readonly connId: number | null;
  readonly retransmit: boolean;
  readonly encrypted: boolean;
  readonly dnsStep: number | null;
  readonly story: Msg;
  readonly stopHint: StopId | null;
  readonly tls: TlsSegCtx | null;
  readonly tcp: TcpCtx | null;
}

export type L4 =
  | { readonly kind: 'udp'; readonly header: UdpHeader }
  | { readonly kind: 'tcp'; readonly header: TcpHeader };

export interface PacketRec {
  readonly id: number;
  readonly tUs: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly path: readonly NodeId[];
  readonly hops: HopTime[];
  arriveUs: number | null;
  lost: boolean;
  readonly ipId: number;
  readonly src: string;
  readonly dst: string;
  readonly l4: L4;
  payload: Uint8Array;
  evicted: boolean;
  readonly size: number;
  readonly meta: PacketMeta;
}

export interface OutPacket {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly l4: L4;
  readonly payload: Uint8Array;
  readonly meta: PacketMeta;
}

export interface Timer {
  cancel(): void;
}

/** Core of the simulation: clock, event queue, log, RNG streams and the packet network. */
export class World {
  readonly clock = new VirtualClock();
  private readonly queue = new EventQueue<() => void>();
  readonly events: SimEvent[] = [];
  readonly packets: PacketRec[] = [];
  readonly nodes: Record<NodeId, NodeDef>;
  readonly linkDefs: LinkDef[];
  private readonly links: Links;
  private readonly routes = new Map<string, NodeId[]>();
  private readonly ipIds = new Map<NodeId, number>();
  readonly rng: Rng;
  readonly rngPorts: Rng;
  readonly rngIsn: Rng;
  readonly rngDnsId: Rng;
  private readonly rngJitter: Rng;
  private readonly rngLoss: Rng;
  private readonly rngIpId: Rng;
  /** Called after every logged event (used for stepping). */
  onLog: ((e: SimEvent) => void) | null = null;

  constructor(
    readonly config: ScenarioConfig,
    readonly site: SiteDef,
  ) {
    this.rng = createRng(config.seed);
    this.rngPorts = this.rng.fork('ports');
    this.rngIsn = this.rng.fork('isn');
    this.rngDnsId = this.rng.fork('dns-id');
    this.rngJitter = this.rng.fork('jitter');
    this.rngLoss = this.rng.fork('loss');
    this.rngIpId = this.rng.fork('ip-id');
    this.nodes = buildNodes(site);
    this.linkDefs = buildLinks(site, config.rttScale);
    this.links = new Links(this.linkDefs);
  }

  get now(): number {
    return this.clock.nowUs;
  }

  at(tUs: number, fn: () => void): void {
    this.queue.push(Math.max(tUs, this.now), fn);
  }

  after(delayUs: number, fn: () => void): void {
    this.at(this.now + Math.round(delayUs), fn);
  }

  timer(delayUs: number, fn: () => void): Timer {
    let live = true;
    this.after(delayUs, () => {
      if (live) fn();
    });
    return {
      cancel: () => {
        live = false;
      },
    };
  }

  log(kind: EventKind, layer: LayerId, node: NodeId, m: Msg, packetId: number | null = null): void {
    const e: SimEvent = {
      seq: this.events.length,
      tUs: this.now,
      kind,
      layer,
      node,
      msg: m,
      packetId,
    };
    this.events.push(e);
    this.onLog?.(e);
  }

  /** Processes one queued task. Returns false when the queue is empty. */
  step(): boolean {
    const item = this.queue.pop();
    if (!item) return false;
    this.clock.advanceTo(item.tUs);
    item.value();
    return true;
  }

  peekTime(): number | null {
    return this.queue.peek()?.tUs ?? null;
  }

  ephemeralPort(): number {
    return this.rngPorts.int(49152, 65535);
  }

  nextIpId(node: NodeId): number {
    let v = this.ipIds.get(node);
    if (v === undefined) v = this.rngIpId.u16();
    this.ipIds.set(node, (v + 1) & 0xffff);
    return v;
  }

  routeOf(from: NodeId, to: NodeId): NodeId[] {
    const k = `${from}>${to}`;
    let r = this.routes.get(k);
    if (!r) {
      r = route(this.linkDefs, from, to);
      this.routes.set(k, r);
    }
    return r;
  }

  send(p: OutPacket, onArrive?: (rec: PacketRec) => void): PacketRec {
    const path = this.routeOf(p.from, p.to);
    const l4len = p.l4.kind === 'udp' ? 8 : 20 + optionLength(p.l4.header);
    const rec: PacketRec = {
      id: this.packets.length + 1,
      tUs: this.now,
      from: p.from,
      to: p.to,
      path,
      hops: [{ node: p.from, tUs: this.now }],
      arriveUs: null,
      lost: false,
      ipId: this.nextIpId(p.from),
      src: this.nodes[p.from].address,
      dst: this.nodes[p.to].address,
      l4: p.l4,
      payload: p.payload,
      evicted: false,
      size: ETHERNET_HEADER_LEN + IPV4_HEADER_LEN + l4len + p.payload.length,
      meta: p.meta,
    };
    this.packets.push(rec);
    this.evictOld();
    this.log(
      'send',
      p.meta.topLayer,
      p.from,
      msg('ev.send', {
        name: p.meta.name,
        from: nodeRef(p.from),
        to: nodeRef(p.to),
        size: rec.size,
      }),
      rec.id,
    );
    this.hop(rec, 0, onArrive);
    return rec;
  }

  private evictOld(): void {
    const over = this.packets.length - MAX_PACKET_DETAILS;
    if (over <= 0) return;
    const old = this.packets[over - 1];
    if (old && !old.evicted) {
      old.evicted = true;
      old.payload = new Uint8Array(0);
    }
  }

  private hop(rec: PacketRec, i: number, onArrive?: (rec: PacketRec) => void): void {
    const a = rec.path[i];
    const b = rec.path[i + 1];
    if (a === undefined || b === undefined) return;
    const link = this.links.get(a, b);
    if (
      link.def.lossy &&
      rec.l4.kind === 'tcp' &&
      this.config.lossRate > 0 &&
      this.rngLoss.next() < this.config.lossRate
    ) {
      const t = this.now + link.def.latencyUs / 2;
      this.at(t, () => {
        rec.lost = true;
        this.log(
          'drop',
          'network',
          a,
          msg('ev.drop', { name: rec.meta.name, a: nodeRef(a), b: nodeRef(b) }),
          rec.id,
        );
      });
      return;
    }
    const arrive = link.transmit(this.now, rec.size, this.rngJitter);
    this.at(arrive, () => {
      rec.hops.push({ node: b, tUs: arrive });
      if (i + 1 === rec.path.length - 1) {
        rec.arriveUs = arrive;
        this.log(
          'arrive',
          rec.meta.topLayer,
          b,
          msg('ev.arrive', { name: rec.meta.name, at: nodeRef(b) }),
          rec.id,
        );
        onArrive?.(rec);
      } else {
        this.hop(rec, i + 1, onArrive);
      }
    });
  }

  /** Number of routers between source and destination (each decrements TTL). */
  routersOn(path: readonly NodeId[]): number {
    let n = 0;
    for (let i = 1; i < path.length - 1; i++) {
      const id = path[i];
      if (id && this.nodes[id].router) n++;
    }
    return n;
  }
}

function optionLength(h: TcpHeader): number {
  let n = 0;
  for (const o of h.options) {
    switch (o.kind) {
      case 'eol':
      case 'nop':
        n += 1;
        break;
      case 'mss':
        n += 4;
        break;
      case 'wscale':
        n += 3;
        break;
      case 'sack-permitted':
        n += 2;
        break;
      case 'sack':
        n += 2 + 8 * o.blocks.length;
        break;
    }
  }
  return n;
}

export const PROTOCOLS = { tcp: PROTO_TCP, udp: PROTO_UDP };
