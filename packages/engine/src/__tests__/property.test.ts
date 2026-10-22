import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { bytesEqual } from '../bytes/writer';
import { internetChecksum } from '../bytes/checksum';
import { encodeFrame, decodeFrame, type FrameSpec } from '../proto/packet';
import {
  DNS_CLASS_IN,
  DNS_TYPE_A,
  DNS_TYPE_NS,
  decodeDns,
  encodeDns,
  type DnsMessage,
} from '../proto/dns';
import type { TcpOption } from '../proto/tcp';
import { createSimulation, runSelfTest } from '../index';

const octet = fc.integer({ min: 0, max: 255 });
const ip = fc.tuple(octet, octet, octet, octet).map((a) => a.join('.'));
const mac = fc
  .array(octet, { minLength: 6, maxLength: 6 })
  .map((a) => a.map((x) => x.toString(16).padStart(2, '0')).join(':'));
const port = fc.integer({ min: 1, max: 65535 });
const u32 = fc.integer({ min: 0, max: 0xffffffff });

const tcpOptions: fc.Arbitrary<TcpOption[]> = fc.constantFrom<TcpOption[]>(
  [],
  [{ kind: 'mss', value: 1460 }],
  [
    { kind: 'mss', value: 1460 },
    { kind: 'nop' },
    { kind: 'wscale', shift: 7 },
    { kind: 'nop' },
    { kind: 'nop' },
    { kind: 'sack-permitted' },
  ],
  [{ kind: 'nop' }, { kind: 'nop' }, { kind: 'sack', blocks: [[1000, 2460]] }],
);

const frameArb: fc.Arbitrary<FrameSpec> = fc.record({
  eth: fc.record({ dst: mac, src: mac, etherType: fc.constant(0x0800) }),
  ip: fc.record({
    dscp: fc.integer({ min: 0, max: 255 }),
    id: fc.integer({ min: 0, max: 65535 }),
    df: fc.boolean(),
    ttl: fc.integer({ min: 1, max: 255 }),
    src: ip,
    dst: ip,
  }),
  l4: fc.oneof(
    fc.record({
      kind: fc.constant('udp' as const),
      header: fc.record({ srcPort: port, dstPort: port }),
    }),
    fc.record({
      kind: fc.constant('tcp' as const),
      header: fc.record({
        srcPort: port,
        dstPort: port,
        seq: u32,
        ack: u32,
        flags: fc.record({
          fin: fc.boolean(),
          syn: fc.boolean(),
          rst: fc.boolean(),
          psh: fc.boolean(),
          ack: fc.boolean(),
          urg: fc.boolean(),
          ece: fc.boolean(),
          cwr: fc.boolean(),
        }),
        window: fc.integer({ min: 0, max: 65535 }),
        urgent: fc.integer({ min: 0, max: 65535 }),
        options: tcpOptions,
      }),
    }),
  ),
  payload: fc.uint8Array({ maxLength: 1400 }),
});

describe('property: packets', () => {
  it('encode → decode → encode gives identical bytes', () => {
    fc.assert(
      fc.property(frameArb, (spec) => {
        // Port 53 would trigger DNS decoding of random bytes; keep L4 payloads opaque here.
        if (spec.l4.header.srcPort === 53 || spec.l4.header.dstPort === 53) return;
        const bytes = encodeFrame(spec);
        const d = decodeFrame(bytes);
        expect(bytesEqual(encodeFrame(d.spec), bytes)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('IPv4, UDP and TCP checksums always verify', () => {
    fc.assert(
      fc.property(frameArb, (spec) => {
        if (spec.l4.header.srcPort === 53 || spec.l4.header.dstPort === 53) return;
        const bytes = encodeFrame(spec);
        expect(internetChecksum(bytes, 14, 34)).toBe(0);
        const d = decodeFrame(bytes);
        expect(d.checks).toEqual({ ipv4: true, l4: true });
      }),
      { numRuns: 300 },
    );
  });
});

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,20}[a-z0-9])?$/);
const name = fc.array(label, { minLength: 1, maxLength: 5 }).map((ls) => ls.join('.'));

describe('property: DNS', () => {
  it('names with random valid labels round-trip, with compression', () => {
    fc.assert(
      fc.property(
        name,
        name,
        fc.integer({ min: 0, max: 0xffff }),
        fc.integer({ min: 0, max: 0x7fffffff }),
        (q, ns, id, ttl) => {
          const m: DnsMessage = {
            id,
            flags: { qr: true, opcode: 0, aa: true, tc: false, rd: false, ra: false, rcode: 0 },
            questions: [{ name: q, type: DNS_TYPE_A, cls: DNS_CLASS_IN }],
            answers: [
              {
                name: q,
                type: DNS_TYPE_A,
                cls: DNS_CLASS_IN,
                ttl,
                data: { kind: 'A', address: '192.0.2.1' },
              },
            ],
            authority: [
              {
                name: q,
                type: DNS_TYPE_NS,
                cls: DNS_CLASS_IN,
                ttl,
                data: { kind: 'NS', host: `${ns}.${q}` },
              },
            ],
            additional: [],
          };
          const bytes = encodeDns(m);
          const d = decodeDns(bytes).message;
          expect(d.questions[0]?.name).toBe(q);
          expect(d.answers[0]?.name).toBe(q);
          expect(d.authority[0]?.data).toEqual({ kind: 'NS', host: `${ns}.${q}` });
          expect(bytesEqual(encodeDns(d), bytes)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: simulation', () => {
  it('seq/ack stay consistent and bytes balance under random loss', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        fc.constantFrom('1.1', '2'),
        (seed, lossRate, httpVersion) => {
          const sim = createSimulation({ seed, lossRate, httpVersion: httpVersion as '1.1' | '2' });
          const results = runSelfTest(sim);
          for (const r of results) expect([r.id, r.pass, r.detail]).toEqual([r.id, true, r.detail]);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('the same seed and config always produce an identical event log', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        (seed, lossRate) => {
          const a = createSimulation({ seed, lossRate });
          const b = createSimulation({ seed, lossRate });
          expect(JSON.stringify(b.getRun().events)).toBe(JSON.stringify(a.getRun().events));
          const last = a.getRun().packets.length;
          expect(
            bytesEqual(
              a.getPacket(last)?.bytes ?? new Uint8Array(1),
              b.getPacket(last)?.bytes ?? new Uint8Array(2),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 15 },
    );
  });
});
