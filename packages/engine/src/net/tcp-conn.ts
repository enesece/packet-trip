import type { LayerId, Msg, NodeId, StopId } from '../model';
import { flags as mkFlags, type TcpFlags, type TcpHeader, type TcpOption } from '../proto/tcp';
import { msg } from '../proto/fields';

export const MSS = 1460;
export const INITIAL_CWND_SEGMENTS = 10;
export const DELAYED_ACK_US = 40_000;
export const MIN_RTO_US = 200_000;
export const INITIAL_RTO_US = 1_000_000;

export interface WriteMeta {
  readonly label: string;
  readonly labelMsg: Msg;
  readonly proto: string;
  readonly topLayer: LayerId;
  readonly encrypted: boolean;
  readonly stop: StopId | null;
  readonly story: Msg;
}

export interface StreamWrite {
  readonly start: number;
  readonly end: number;
  readonly meta: WriteMeta;
}

/** Hooks the endpoint uses to reach the simulator. */
export interface TcpHost {
  now(): number;
  timer(delayUs: number, fn: () => void): { cancel(): void };
  /** Hands a segment to the network. Returns nothing; loss happens in the network. */
  emit(ep: TcpEndpoint, header: TcpHeader, payload: Uint8Array, info: SegmentInfo): void;
  log(ep: TcpEndpoint, kind: 'state' | 'timeout', m: Msg): void;
}

export interface SegmentInfo {
  readonly name: string;
  readonly nameMsg: Msg;
  readonly proto: string;
  readonly topLayer: LayerId;
  readonly encrypted: boolean;
  readonly retransmit: boolean;
  readonly stop: StopId | null;
  readonly story: Msg;
  /** Offset of the payload in this direction's byte stream (0 = first data byte). */
  readonly streamOffset: number;
  readonly flagsLabel: string;
}

export interface TcpCallbacks {
  onEstablished(): void;
  onData(data: Uint8Array): void;
  onPeerFin(): void;
}

type State =
  | 'CLOSED'
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT';

const seqLt = (a: number, b: number): boolean => ((a - b) | 0) < 0;
const seqLe = (a: number, b: number): boolean => ((a - b) | 0) <= 0;
const add = (a: number, n: number): number => (a + n) >>> 0;
const diff = (a: number, b: number): number => (a - b) | 0;

export interface EndpointOpts {
  readonly connId: number;
  readonly node: NodeId;
  readonly peerNode: NodeId;
  readonly ip: string;
  readonly peerIp: string;
  readonly port: number;
  readonly peerPort: number;
  readonly isn: number;
  readonly wscale: number;
  readonly synWindow: number;
  /** Receive buffer in bytes (advertised, scaled). */
  readonly rcvBuffer: number;
  readonly role: 'client' | 'server';
}

/**
 * One side of a TCP connection. Sequence numbers are real 32-bit values with wraparound.
 * Congestion control: slow start from 10 segments, congestion avoidance, NewReno-style fast
 * retransmit/recovery on three duplicate ACKs, and RFC 6298 retransmission timeouts.
 */
export class TcpEndpoint {
  state: State = 'CLOSED';
  readonly isn: number;
  peerIsn = 0;
  peerWscale = 0;

  // Send side
  sndUna: number;
  sndNxt: number;
  sndMax: number;
  private stream: Uint8Array = new Uint8Array(4096);
  private streamLen = 0;
  readonly writes: StreamWrite[] = [];
  cwnd = INITIAL_CWND_SEGMENTS * MSS;
  ssthresh = 0x7fffffff;
  rwnd = 65535;
  private dupAcks = 0;
  private inRecovery = false;
  private recover = 0;
  private finQueued = false;
  private finSent = false;
  private finSeq = 0;
  private srtt = 0;
  private rttvar = 0;
  rto = INITIAL_RTO_US;
  private rtoTimer: { cancel(): void } | null = null;
  private rttSample: { seq: number; at: number } | null = null;
  retransmits = 0;
  bytesSentApp = 0;

  // Receive side
  rcvNxt = 0;
  private ooo = new Map<number, Uint8Array>();
  private unackedSegs = 0;
  private delAck: { cancel(): void } | null = null;
  bytesDelivered = 0;
  peerFinSeen = false;

  constructor(
    readonly opts: EndpointOpts,
    private readonly host: TcpHost,
    readonly cb: TcpCallbacks,
  ) {
    this.isn = opts.isn >>> 0;
    this.sndUna = this.isn;
    this.sndNxt = this.isn;
    this.sndMax = this.isn;
  }

  get connId(): number {
    return this.opts.connId;
  }

  /** Bytes the app wrote to this side's stream. */
  get streamBytes(): Uint8Array {
    return this.stream.subarray(0, this.streamLen);
  }

  private synOptions(): TcpOption[] {
    return [
      { kind: 'mss', value: MSS },
      { kind: 'nop' },
      { kind: 'wscale', shift: this.opts.wscale },
      { kind: 'nop' },
      { kind: 'nop' },
      { kind: 'sack-permitted' },
    ];
  }

  private windowField(syn: boolean): number {
    if (syn) return this.opts.synWindow;
    return Math.min(0xffff, Math.floor(this.opts.rcvBuffer / 2 ** this.opts.wscale));
  }

  private header(fl: Partial<TcpFlags>, seq: number, options: TcpOption[] = []): TcpHeader {
    const f = mkFlags(fl);
    return {
      srcPort: this.opts.port,
      dstPort: this.opts.peerPort,
      seq,
      ack: f.ack ? this.rcvNxt : 0,
      flags: f,
      window: this.windowField(f.syn),
      urgent: 0,
      options,
    };
  }

  private control(
    name: string,
    nameMsg: Msg,
    fl: Partial<TcpFlags>,
    seq: number,
    opts: TcpOption[],
    retransmit: boolean,
    story: Msg,
    stop: StopId | null,
  ): void {
    const h = this.header(fl, seq, opts);
    if (h.flags.ack) {
      // Any segment with ACK satisfies a pending delayed ACK.
      this.cancelDelAck();
      this.unackedSegs = 0;
    }
    this.host.emit(this, h, new Uint8Array(0), {
      name: retransmit ? `Retransmission: ${name}` : name,
      nameMsg: retransmit ? msg('p.retx', { name }) : nameMsg,
      proto: 'TCP',
      topLayer: 'transport',
      encrypted: false,
      retransmit,
      stop,
      story,
      streamOffset: diff(seq, add(this.isn, 1)),
      flagsLabel: name,
    });
  }

  // ---------------------------------------------------------------- opening

  connect(): void {
    this.state = 'SYN_SENT';
    this.sendSyn(false);
  }

  private sendSyn(retx: boolean): void {
    this.control(
      'SYN',
      msg('p.syn'),
      { syn: true },
      this.isn,
      this.synOptions(),
      retx,
      msg('story.syn'),
      'tcp',
    );
    this.sndNxt = add(this.isn, 1);
    this.sndMax = this.sndNxt;
    this.armRto();
  }

  listen(): void {
    this.state = 'LISTEN';
  }

  /** For pre-warmed connections (CDN ↔ origin): skip the handshake. */
  establishWith(peerIsn: number, peerWscale: number): void {
    this.state = 'ESTABLISHED';
    this.peerIsn = peerIsn >>> 0;
    this.peerWscale = peerWscale;
    this.rcvNxt = add(peerIsn, 1);
    this.sndUna = add(this.isn, 1);
    this.sndNxt = this.sndUna;
    this.sndMax = this.sndUna;
    this.rwnd = 1 << 20;
  }

  // ---------------------------------------------------------------- app API

  write(data: Uint8Array, meta: WriteMeta): void {
    if (this.streamLen + data.length > this.stream.length) {
      let size = this.stream.length * 2;
      while (size < this.streamLen + data.length) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.stream.subarray(0, this.streamLen));
      this.stream = next;
    }
    this.stream.set(data, this.streamLen);
    this.writes.push({ start: this.streamLen, end: this.streamLen + data.length, meta });
    this.streamLen += data.length;
    this.bytesSentApp += data.length;
    this.trySend();
  }

  close(): void {
    this.finQueued = true;
    this.trySend();
  }

  // ---------------------------------------------------------------- sending

  private streamOffset(seq: number): number {
    return diff(seq, add(this.isn, 1));
  }

  private writeAt(off: number): StreamWrite | undefined {
    // Linear scan is fine: a run has at most a few dozen writes per side.
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const w = this.writes[i];
      if (w && w.start <= off && off < w.end) return w;
    }
    return undefined;
  }

  private canSend(): boolean {
    return (
      this.state === 'ESTABLISHED' ||
      this.state === 'CLOSE_WAIT' ||
      this.state === 'FIN_WAIT_1' ||
      this.state === 'LAST_ACK'
    );
  }

  trySend(): void {
    if (!this.canSend() && this.state !== 'SYN_RCVD') return;
    if (this.state === 'SYN_RCVD') return;
    for (;;) {
      const off = this.streamOffset(this.sndNxt);
      if (off >= this.streamLen) break;
      const w = this.writeAt(off);
      if (!w) break;
      const len = Math.min(MSS, w.end - off);
      const flight = diff(this.sndNxt, this.sndUna);
      if (flight + len > Math.min(this.cwnd, this.rwnd)) break;
      this.sendData(off, len, w);
    }
    const allSent = this.streamOffset(this.sndNxt) >= this.streamLen;
    if (this.finQueued && allSent && !this.finSent) {
      this.finSent = true;
      this.finSeq = this.sndNxt;
      this.state = this.state === 'CLOSE_WAIT' ? 'LAST_ACK' : 'FIN_WAIT_1';
      this.control(
        'FIN, ACK',
        msg('p.fin'),
        { fin: true, ack: true },
        this.sndNxt,
        [],
        false,
        msg('story.fin'),
        null,
      );
      this.sndNxt = add(this.sndNxt, 1);
      if (seqLt(this.sndMax, this.sndNxt)) this.sndMax = this.sndNxt;
      this.armRto();
    }
  }

  private sendData(off: number, len: number, w: StreamWrite): void {
    const seq = this.sndNxt;
    const retransmit = seqLt(seq, this.sndMax);
    const segIdx = Math.floor((off - w.start) / MSS) + 1;
    const segCount = Math.ceil((w.end - w.start) / MSS);
    const partOf = segCount > 1 ? ` (${segIdx}/${segCount})` : '';
    const last = off + len === w.end;
    const h = this.header({ ack: true, psh: last }, seq);
    const baseName = `${w.meta.label}${partOf}`;
    this.host.emit(this, h, this.stream.slice(off, off + len), {
      name: retransmit ? `Retransmission: ${baseName}` : baseName,
      nameMsg: retransmit
        ? msg('p.retx', { name: baseName })
        : segCount > 1
          ? msg('p.part', { name: w.meta.label, i: segIdx, n: segCount })
          : w.meta.labelMsg,
      proto: w.meta.proto,
      topLayer: w.meta.topLayer,
      encrypted: w.meta.encrypted,
      retransmit,
      stop: w.meta.stop,
      story: retransmit ? msg('story.retx') : w.meta.story,
      streamOffset: off,
      flagsLabel: last ? 'PSH, ACK' : 'ACK',
    });
    if (retransmit) this.retransmits++;
    this.unackedSegs = 0;
    if (!retransmit && !this.rttSample)
      this.rttSample = { seq: add(seq, len), at: this.host.now() };
    this.sndNxt = add(seq, len);
    if (seqLt(this.sndMax, this.sndNxt)) this.sndMax = this.sndNxt;
    // Data carries the ACK, so any pending delayed ACK is satisfied.
    this.cancelDelAck();
    if (!this.rtoTimer) this.armRto();
  }

  private sendAck(reason: 'delayed' | 'immediate' | 'dup'): void {
    const name = reason === 'dup' ? 'ACK (duplicate)' : 'ACK';
    this.control(
      name,
      reason === 'dup' ? msg('p.dupack') : msg('p.ack'),
      { ack: true },
      this.sndNxt,
      [],
      false,
      reason === 'dup' ? msg('story.dupack') : msg('story.ack'),
      null,
    );
  }

  private cancelDelAck(): void {
    this.delAck?.cancel();
    this.delAck = null;
  }

  private armRto(): void {
    this.rtoTimer?.cancel();
    this.rtoTimer = this.host.timer(this.rto, () => this.onRto());
  }

  private stopRto(): void {
    this.rtoTimer?.cancel();
    this.rtoTimer = null;
  }

  private consecutiveRtos = 0;

  private onRto(): void {
    this.rtoTimer = null;
    if (++this.consecutiveRtos > 8) {
      this.host.log(this, 'state', msg('ev.giveup'));
      this.state = 'CLOSED';
      return;
    }
    if (this.state === 'SYN_SENT') {
      this.host.log(this, 'timeout', msg('ev.rto.syn', { ms: Math.round(this.rto / 1000) }));
      this.rto = Math.min(this.rto * 2, 60_000_000);
      this.sendSyn(true);
      return;
    }
    if (this.state === 'SYN_RCVD') {
      this.host.log(this, 'timeout', msg('ev.rto.synack', { ms: Math.round(this.rto / 1000) }));
      this.rto = Math.min(this.rto * 2, 60_000_000);
      this.sendSynAck(true);
      return;
    }
    if (!seqLt(this.sndUna, this.sndMax)) return;
    this.host.log(this, 'timeout', msg('ev.rto', { ms: Math.round(this.rto / 1000) }));
    const flight = diff(this.sndMax, this.sndUna);
    this.ssthresh = Math.max(Math.floor(flight / 2), 2 * MSS);
    this.cwnd = MSS;
    this.inRecovery = false;
    this.dupAcks = 0;
    this.rto = Math.min(this.rto * 2, 60_000_000);
    this.rttSample = null;
    // Go back N: resend from the first unacknowledged byte as the window allows.
    this.sndNxt = this.sndUna;
    if (this.finSent && this.sndUna === this.finSeq) {
      this.control(
        'FIN, ACK',
        msg('p.fin'),
        { fin: true, ack: true },
        this.finSeq,
        [],
        true,
        msg('story.fin'),
        null,
      );
      this.sndNxt = add(this.finSeq, 1);
    } else {
      this.trySend();
      if (this.finSent && this.sndNxt === this.finSeq) {
        this.control(
          'FIN, ACK',
          msg('p.fin'),
          { fin: true, ack: true },
          this.finSeq,
          [],
          true,
          msg('story.fin'),
          null,
        );
        this.sndNxt = add(this.finSeq, 1);
      }
    }
    this.armRto();
  }

  private sendSynAck(retx: boolean): void {
    this.control(
      'SYN, ACK',
      msg('p.synack'),
      { syn: true, ack: true },
      this.isn,
      this.synOptions(),
      retx,
      msg('story.synack'),
      'tcp',
    );
    this.sndNxt = add(this.isn, 1);
    this.sndMax = this.sndNxt;
    this.armRto();
  }

  private retransmitFirst(): void {
    const off = this.streamOffset(this.sndUna);
    const w = this.writeAt(off);
    if (w) {
      const save = this.sndNxt;
      this.sndNxt = this.sndUna;
      this.sendData(off, Math.min(MSS, w.end - off), w);
      if (seqLt(this.sndNxt, save)) this.sndNxt = save;
    } else if (this.finSent && this.sndUna === this.finSeq) {
      this.control(
        'FIN, ACK',
        msg('p.fin'),
        { fin: true, ack: true },
        this.finSeq,
        [],
        true,
        msg('story.fin'),
        null,
      );
    }
  }

  // ---------------------------------------------------------------- receiving

  receive(h: TcpHeader, payload: Uint8Array): void {
    const f = h.flags;
    if (f.rst) {
      this.state = 'CLOSED';
      return;
    }
    switch (this.state) {
      case 'LISTEN': {
        if (!f.syn) return;
        this.peerIsn = h.seq;
        this.rcvNxt = add(h.seq, 1);
        this.peerWscale = wscaleOf(h.options);
        this.rwnd = h.window;
        this.state = 'SYN_RCVD';
        this.sendSynAck(false);
        return;
      }
      case 'SYN_SENT': {
        if (f.syn && f.ack && h.ack === add(this.isn, 1)) {
          this.peerIsn = h.seq;
          this.rcvNxt = add(h.seq, 1);
          this.peerWscale = wscaleOf(h.options);
          this.sndUna = h.ack;
          this.rwnd = h.window;
          this.stopRto();
          this.state = 'ESTABLISHED';
          this.control(
            'ACK',
            msg('p.ack3'),
            { ack: true },
            this.sndNxt,
            [],
            false,
            msg('story.ack3'),
            'tcp',
          );
          this.host.log(this, 'state', msg('ev.established'));
          this.cb.onEstablished();
        }
        return;
      }
      case 'SYN_RCVD': {
        if (f.syn && !f.ack) {
          // Our SYN-ACK was lost and the client retransmitted its SYN.
          this.sendSynAck(true);
          return;
        }
        if (f.ack && h.ack === add(this.isn, 1)) {
          this.sndUna = h.ack;
          this.stopRto();
          this.rto = INITIAL_RTO_US;
          this.state = 'ESTABLISHED';
          this.rwnd = h.window * 2 ** this.peerWscale;
          this.host.log(this, 'state', msg('ev.established'));
          this.cb.onEstablished();
          if (payload.length > 0 || f.fin) this.receive(h, payload);
        }
        return;
      }
      default:
        break;
    }
    if (this.state === 'CLOSED') return;
    if (f.syn) {
      // Retransmitted SYN-ACK: our ACK was lost. Acknowledge again.
      if (f.ack) this.sendAck('immediate');
      return;
    }
    if (f.ack) this.processAck(h, payload.length > 0 || f.fin);
    if (payload.length > 0) this.processData(h.seq, payload);
    if (f.fin) this.processFin(add(h.seq, payload.length));
  }

  private processAck(h: TcpHeader, carriesData: boolean): void {
    this.rwnd = h.window * 2 ** this.peerWscale;
    const ack = h.ack;
    if (seqLt(this.sndMax, ack)) return; // acks something never sent
    if (seqLt(this.sndUna, ack)) {
      this.consecutiveRtos = 0;
      const acked = diff(ack, this.sndUna);
      this.sndUna = ack;
      if (seqLt(this.sndNxt, this.sndUna)) this.sndNxt = this.sndUna;
      this.dupAcks = 0;
      if (this.rttSample && seqLe(this.rttSample.seq, ack)) {
        this.updateRtt(this.host.now() - this.rttSample.at);
        this.rttSample = null;
      }
      if (this.inRecovery) {
        if (seqLe(this.recover, ack)) {
          this.inRecovery = false;
          this.cwnd = this.ssthresh;
        } else {
          // Partial ACK (NewReno): the next hole is lost too.
          this.retransmitFirst();
          this.cwnd = Math.max(MSS, this.cwnd - acked + MSS);
        }
      } else if (this.cwnd < this.ssthresh) {
        this.cwnd += Math.min(acked, 2 * MSS);
      } else {
        this.cwnd += Math.max(1, Math.floor((MSS * MSS) / this.cwnd));
      }
      if (this.finSent && seqLt(this.finSeq, ack)) this.onFinAcked();
      if (seqLt(this.sndUna, this.sndMax)) this.armRto();
      else this.stopRto();
      this.trySend();
      return;
    }
    if (ack === this.sndUna && seqLt(this.sndUna, this.sndMax) && !carriesData) {
      this.dupAcks++;
      if (this.dupAcks === 3 && !this.inRecovery) {
        this.host.log(this, 'state', msg('ev.fastretx'));
        const flight = diff(this.sndMax, this.sndUna);
        this.ssthresh = Math.max(Math.floor(flight / 2), 2 * MSS);
        this.cwnd = this.ssthresh + 3 * MSS;
        this.inRecovery = true;
        this.recover = this.sndMax;
        this.rttSample = null;
        this.retransmitFirst();
        this.armRto();
      } else if (this.inRecovery) {
        this.cwnd += MSS;
        this.trySend();
      }
    }
  }

  private updateRtt(sample: number): void {
    if (this.srtt === 0) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
    this.rto = Math.max(MIN_RTO_US, Math.round(this.srtt + 4 * this.rttvar));
  }

  private processData(seq: number, payload: Uint8Array): void {
    if (seq === this.rcvNxt) {
      const hadHole = this.ooo.size > 0;
      this.deliver(payload);
      this.rcvNxt = add(this.rcvNxt, payload.length);
      // Pull any buffered out-of-order segments that are now contiguous.
      let next = this.ooo.get(this.rcvNxt);
      while (next) {
        this.ooo.delete(this.rcvNxt);
        this.deliver(next);
        this.rcvNxt = add(this.rcvNxt, next.length);
        next = this.ooo.get(this.rcvNxt);
      }
      if (hadHole) {
        this.sendAck('immediate');
        return;
      }
      this.unackedSegs++;
      if (this.unackedSegs >= 2) {
        this.sendAck('delayed');
      } else if (!this.delAck) {
        this.delAck = this.host.timer(DELAYED_ACK_US, () => {
          this.delAck = null;
          if (this.unackedSegs > 0) this.sendAck('delayed');
        });
      }
    } else if (seqLt(this.rcvNxt, seq)) {
      if (!this.ooo.has(seq)) this.ooo.set(seq, payload);
      this.sendAck('dup');
    } else {
      // Old data (a retransmission we already had): re-acknowledge immediately.
      this.sendAck('immediate');
    }
  }

  private deliver(data: Uint8Array): void {
    this.bytesDelivered += data.length;
    this.cb.onData(data);
  }

  private processFin(finSeq: number): void {
    if (this.peerFinSeen) {
      // A retransmitted FIN: our ACK was lost, so acknowledge it again.
      if (add(finSeq, 1) === this.rcvNxt) this.sendAck('immediate');
      return;
    }
    if (finSeq !== this.rcvNxt) return;
    this.peerFinSeen = true;
    this.rcvNxt = add(this.rcvNxt, 1);
    if (this.state === 'ESTABLISHED') this.state = 'CLOSE_WAIT';
    else if (this.state === 'FIN_WAIT_2') this.state = 'TIME_WAIT';
    else if (this.state === 'FIN_WAIT_1') this.state = 'CLOSING';
    this.cb.onPeerFin();
    if (this.state === 'CLOSE_WAIT' && this.finQueued) {
      this.trySend();
    } else if (!this.finSent || this.state === 'TIME_WAIT') {
      this.sendAck('immediate');
    }
  }

  private onFinAcked(): void {
    if (this.state === 'FIN_WAIT_1') this.state = 'FIN_WAIT_2';
    else if (this.state === 'CLOSING') this.state = 'TIME_WAIT';
    else if (this.state === 'LAST_ACK') this.state = 'CLOSED';
    this.host.log(this, 'state', msg('ev.state', { state: this.state }));
  }

  get flightSegments(): number {
    return Math.ceil(this.cwnd / MSS);
  }
}

function wscaleOf(opts: readonly TcpOption[]): number {
  for (const o of opts) if (o.kind === 'wscale') return o.shift;
  return 0;
}
