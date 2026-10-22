import type { ConnectionInfo, NodeId } from '../model';
import { TcpEndpoint, type TcpCallbacks, type TcpHost, type WriteMeta } from '../net/tcp-conn';
import type { SealedWrite } from '../crypto/types';
import { msg } from '../proto/fields';
import type { RecordSpan, World } from './world';

/** Splits a TCP byte stream into complete TLS records. */
export class RecordReader {
  private buf = new Uint8Array(0);

  feed(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let pos = 0;
    while (merged.length - pos >= 5) {
      const len = ((merged[pos + 3] ?? 0) << 8) | (merged[pos + 4] ?? 0);
      if (merged.length - pos < 5 + len) break;
      out.push(merged.slice(pos, pos + 5 + len));
      pos += 5 + len;
    }
    this.buf = merged.slice(pos);
    return out;
  }
}

export interface ConnectionOpts {
  readonly id: number;
  readonly label: string;
  readonly clientNode: NodeId;
  readonly serverNode: NodeId;
  readonly serverPort: number;
  readonly tls: '1.2' | '1.3';
  readonly client: TcpCallbacks;
  readonly server: TcpCallbacks;
}

/** A TCP connection: two endpoints wired through the simulated network. */
export class Connection {
  readonly client: TcpEndpoint;
  readonly server: TcpEndpoint;
  readonly spans: { client: RecordSpan[]; server: RecordSpan[] } = { client: [], server: [] };
  private recordIndex = { client: 0, server: 0 };

  constructor(
    w: World,
    readonly opts: ConnectionOpts,
  ) {
    const N = w.nodes;
    const host: TcpHost = {
      now: () => w.now,
      timer: (d, fn) => w.timer(d, fn),
      log: (ep, kind, m) => w.log(kind, 'transport', ep.opts.node, m),
      emit: (ep, header, payload, info) => {
        const side = ep === this.client ? 'client' : 'server';
        const peer = side === 'client' ? this.server : this.client;
        w.send(
          {
            from: ep.opts.node,
            to: ep.opts.peerNode,
            l4: { kind: 'tcp', header },
            payload,
            meta: {
              proto: payload.length > 0 ? info.proto : 'TCP',
              name: info.name,
              nameMsg: info.nameMsg,
              topLayer: payload.length > 0 ? info.topLayer : 'transport',
              flow: 'tcp',
              connId: opts.id,
              retransmit: info.retransmit,
              encrypted: info.encrypted,
              dnsStep: null,
              story: info.story,
              stopHint: info.stop,
              tls:
                payload.length > 0
                  ? { spans: this.spans[side], streamOffset: info.streamOffset, version: opts.tls }
                  : null,
              tcp: {
                isnSrc: ep.isn,
                isnDst: header.flags.ack ? ep.peerIsn : null,
                wscaleSrc: ep.opts.wscale,
              },
            },
          },
          () => peer.receive(header, payload),
        );
      },
    };
    const isnRng = w.rngIsn;
    this.client = new TcpEndpoint(
      {
        connId: opts.id,
        node: opts.clientNode,
        peerNode: opts.serverNode,
        ip: N[opts.clientNode].address,
        peerIp: N[opts.serverNode].address,
        port: opts.clientNode === 'laptop' ? w.ephemeralPort() : 40000 + isnRng.int(0, 9999),
        peerPort: opts.serverPort,
        isn: isnRng.u32(),
        wscale: 7,
        synWindow: 64240,
        rcvBuffer: 262144,
        role: 'client',
      },
      host,
      opts.client,
    );
    this.server = new TcpEndpoint(
      {
        connId: opts.id,
        node: opts.serverNode,
        peerNode: opts.clientNode,
        ip: N[opts.serverNode].address,
        peerIp: N[opts.clientNode].address,
        port: opts.serverPort,
        peerPort: this.client.opts.port,
        isn: isnRng.u32(),
        wscale: 9,
        synWindow: 65535,
        rcvBuffer: 262144,
        role: 'server',
      },
      host,
      opts.server,
    );
  }

  /** Writes a sealed TLS flight on one side, remembering where each record sits in the stream. */
  writeSealed(side: 'client' | 'server', write: SealedWrite, meta: WriteMeta): void {
    const ep = side === 'client' ? this.client : this.server;
    let off = ep.streamBytes.length;
    for (const rec of write.records) {
      this.spans[side].push({
        start: off,
        end: off + rec.bytes.length,
        index: this.recordIndex[side]++,
        rec,
      });
      off += rec.bytes.length;
    }
    ep.write(write.bytes, meta);
  }

  info(): ConnectionInfo {
    const label = this.opts.label;
    return {
      id: this.opts.id,
      client: `${this.client.opts.ip}:${this.client.opts.port}`,
      server: `${this.server.opts.ip}:${this.server.opts.port}`,
      state: this.client.state,
      clientIsn: this.client.isn,
      serverIsn: this.server.isn,
      bytesClientToServer: this.client.bytesSentApp,
      bytesServerToClient: this.server.bytesSentApp,
      cwndSegments: this.server.flightSegments,
      retransmits: this.client.retransmits + this.server.retransmits,
      label,
    };
  }
}

export const noCallbacks: TcpCallbacks = {
  onEstablished: () => undefined,
  onData: () => undefined,
  onPeerFin: () => undefined,
};

export { msg };
