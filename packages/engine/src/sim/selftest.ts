import type { Msg } from '../model';
import { bytesEqual } from '../bytes/writer';
import { encodeFrame } from '../proto/packet';
import { decodeDns } from '../proto/dns';
import { internetChecksum, pseudoHeaderSum } from '../bytes/checksum';
import { PROTO_TCP, PROTO_UDP } from '../proto/ipv4';
import { msg } from '../proto/fields';
import type { Simulation } from './simulator';

export interface SelfTestResult {
  readonly id: 'roundtrip' | 'checksums' | 'seqack' | 'dnsnames' | 'bytes';
  readonly pass: boolean;
  readonly checked: number;
  readonly detail: Msg;
}

const add = (a: number, n: number): number => (a + n) >>> 0;
const lt = (a: number, b: number): boolean => ((a - b) | 0) < 0;

/** The checks behind the Expert-mode "Run checks" panel (also used by the unit tests). */
export function runSelfTest(sim: Simulation): SelfTestResult[] {
  const { full, frameOf, material } = sim.internals;
  const w = full.w;
  const results: SelfTestResult[] = [];

  // 1. encode → decode → encode gives identical bytes, for every packet.
  {
    let n = 0;
    const bad: number[] = [];
    for (const p of w.packets) {
      if (p.evicted) continue;
      const f = frameOf(p.id);
      if (!f) continue;
      n++;
      const again = encodeFrame(f.decoded.spec);
      if (!bytesEqual(again, f.bytes) || !f.decoded.app.ok) bad.push(p.id);
    }
    results.push({
      id: 'roundtrip',
      pass: bad.length === 0,
      checked: n,
      detail: bad.length
        ? msg('check.fail.packets', { ids: bad.slice(0, 8).join(', ') })
        : msg('check.ok.roundtrip', { n }),
    });
  }

  // 2. Checksums verify (IPv4 header, UDP and TCP with pseudo-header).
  {
    let n = 0;
    const bad: number[] = [];
    for (const p of w.packets) {
      const f = p.evicted ? null : frameOf(p.id);
      if (!f) continue;
      n++;
      const b = f.bytes;
      const ipOk = internetChecksum(b, 14, 34) === 0;
      const seg = b.subarray(34);
      const proto = p.l4.kind === 'udp' ? PROTO_UDP : PROTO_TCP;
      const l4Ok =
        internetChecksum(seg, 0, seg.length, pseudoHeaderSum(p.src, p.dst, proto, seg.length)) ===
        0;
      if (!ipOk || !l4Ok || !f.decoded.checks.ipv4 || !f.decoded.checks.l4) bad.push(p.id);
    }
    results.push({
      id: 'checksums',
      pass: bad.length === 0,
      checked: n * 2,
      detail: bad.length
        ? msg('check.fail.packets', { ids: bad.slice(0, 8).join(', ') })
        : msg('check.ok.checksums', { n }),
    });
  }

  // 3. Sequence and acknowledgment numbers stay consistent per connection and direction.
  {
    const problems: string[] = [];
    let n = 0;
    for (const conn of full.web.connections) {
      for (const side of ['client', 'server'] as const) {
        const ep = side === 'client' ? conn.client : conn.server;
        const peer = side === 'client' ? conn.server : conn.client;
        const from = ep.opts.node;
        const to = peer.opts.node;
        let lastAck: number | null = null;
        const base = add(ep.isn, 1);
        const streamLen = ep.streamBytes.length;
        for (const p of w.packets) {
          if (
            p.l4.kind !== 'tcp' ||
            p.meta.connId !== conn.opts.id ||
            p.from !== from ||
            p.to !== to
          )
            continue;
          n++;
          const h = p.l4.header;
          if (h.flags.syn) {
            if (h.seq !== ep.isn) problems.push(`#${p.id} SYN seq ≠ ISN`);
            continue;
          }
          const off = (h.seq - base) | 0;
          // A FIN occupies one sequence number after the last data byte.
          const finExtra = h.flags.fin || p.payload.length === 0 ? 1 : 0;
          if (off < 0 || off + p.payload.length > streamLen + finExtra)
            problems.push(`#${p.id} seq outside stream`);
          if (h.flags.ack) {
            if (lastAck !== null && lt(h.ack, lastAck))
              problems.push(`#${p.id} ack went backwards`);
            const peerMax = add(peer.isn, 1 + peer.streamBytes.length + 1);
            if (lt(peerMax, h.ack)) problems.push(`#${p.id} acks unsent data`);
            lastAck = h.ack;
          }
        }
        // Everything the peer sent was eventually acknowledged (when the run closed cleanly).
        if (lastAck !== null && peer.bytesSentApp > 0) {
          const want = add(peer.isn, 1 + peer.streamBytes.length);
          if (lt(lastAck, want)) problems.push(`${side}: final ack short of peer stream`);
        }
      }
    }
    results.push({
      id: 'seqack',
      pass: problems.length === 0,
      checked: n,
      detail: problems.length
        ? msg('check.fail.text', { text: problems.slice(0, 4).join('; ') })
        : msg('check.ok.seqack', { n }),
    });
  }

  // 4. DNS names decode.
  {
    let n = 0;
    const bad: number[] = [];
    for (const p of w.packets) {
      if (p.meta.flow !== 'dns' || p.evicted) continue;
      n++;
      try {
        const d = decodeDns(p.payload);
        if (d.message.questions[0]?.name !== w.site.host) bad.push(p.id);
      } catch {
        bad.push(p.id);
      }
    }
    results.push({
      id: 'dnsnames',
      pass: bad.length === 0,
      checked: n,
      detail: bad.length
        ? msg('check.fail.packets', { ids: bad.join(', ') })
        : msg('check.ok.dns', { n }),
    });
  }

  // 5. Bytes in = bytes out, per connection and direction.
  {
    const problems: string[] = [];
    let n = 0;
    for (const conn of full.web.connections) {
      for (const [a, b, dir] of [
        [conn.client, conn.server, 'client→server'],
        [conn.server, conn.client, 'server→client'],
      ] as const) {
        n++;
        if (a.bytesSentApp !== b.bytesDelivered)
          problems.push(
            `conn ${conn.opts.id} ${dir}: ${a.bytesSentApp} sent, ${b.bytesDelivered} delivered`,
          );
      }
    }
    const main = full.web.connections.find((c) => c.opts.id === 1);
    if (main) {
      const planned = [
        ...material.main.handshake,
        ...material.main.requests,
        ...material.main.responses,
      ].reduce((s, wr) => s + wr.bytes.length, 0);
      const moved = main.client.bytesSentApp + main.server.bytesSentApp;
      if (planned !== moved)
        problems.push(`main connection moved ${moved} B, plan has ${planned} B`);
    }
    results.push({
      id: 'bytes',
      pass: problems.length === 0,
      checked: n,
      detail: problems.length
        ? msg('check.fail.text', { text: problems.join('; ') })
        : msg('check.ok.bytes', { n }),
    });
  }
  return results;
}
