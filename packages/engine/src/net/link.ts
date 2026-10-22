import type { NodeId } from '../model';
import type { Rng } from '../sim/rng';
import type { LinkDef } from './topology';

/**
 * One direction of a link: a FIFO transmitter. A packet starts serializing when the line is free,
 * takes size×8/bandwidth to put on the wire, then propagates for latency + jitter. Jitter never
 * reorders packets on the same link direction.
 */
export class LinkDirection {
  private busyUntil = 0;
  private lastArrival = 0;

  constructor(
    readonly def: LinkDef,
    readonly from: NodeId,
    readonly to: NodeId,
  ) {}

  /** Returns the arrival time of the packet's last bit at the far end. */
  transmit(nowUs: number, sizeBytes: number, jitterRng: Rng): number {
    const start = Math.max(nowUs, this.busyUntil);
    const txUs = Math.max(1, Math.round((sizeBytes * 8 * 1_000_000) / this.def.bandwidthBps));
    this.busyUntil = start + txUs;
    const jitter = this.def.jitterUs > 0 ? Math.round(jitterRng.next() * this.def.jitterUs) : 0;
    const arrive = Math.max(start + txUs + this.def.latencyUs + jitter, this.lastArrival + 1);
    this.lastArrival = arrive;
    return arrive;
  }
}

export class Links {
  private readonly dirs = new Map<string, LinkDirection>();

  constructor(readonly defs: readonly LinkDef[]) {
    for (const d of defs) {
      this.dirs.set(`${d.a}>${d.b}`, new LinkDirection(d, d.a, d.b));
      this.dirs.set(`${d.b}>${d.a}`, new LinkDirection(d, d.b, d.a));
    }
  }

  get(from: NodeId, to: NodeId): LinkDirection {
    const d = this.dirs.get(`${from}>${to}`);
    if (!d) throw new Error(`no link ${from} → ${to}`);
    return d;
  }
}
