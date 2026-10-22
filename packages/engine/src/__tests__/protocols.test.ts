import { describe, expect, it } from 'vitest';
import { toHex, fromHex } from '../bytes/hex';
import { asciiBytes } from '../bytes/writer';
import { encodeEthernet, decodeEthernet } from '../proto/ethernet';
import { encodeIpv4, decodeIpv4 } from '../proto/ipv4';
import { encodeUdp, decodeUdp } from '../proto/udp';
import { encodeTcp, decodeTcp, flags } from '../proto/tcp';
import {
  DNS_CLASS_IN,
  DNS_TYPE_A,
  DNS_TYPE_NS,
  decodeDns,
  encodeDns,
  type DnsMessage,
} from '../proto/dns';
import { encodeRecord, ext, handshake, clientHello, decodeHandshakes } from '../proto/tls';
import { encodeRequest, decodeHttp1, Http1ResponseParser, encodeResponse } from '../proto/http1';
import { encodeFrame as h2Frame, H2FrameReader, H2_DATA, FLAG_END_STREAM } from '../proto/http2';
import { fakeCertificate, parseCertSummary } from '../proto/der';
import { createRng } from '../sim/rng';

const hex = (b: Uint8Array): string => toHex(b, 0, b.length, ' ');

describe('Ethernet II', () => {
  it('lays out destination, source and EtherType', () => {
    const f = encodeEthernet(
      { dst: '02:00:5e:10:00:01', src: '02:00:5e:10:00:24', etherType: 0x0800 },
      Uint8Array.of(0xaa),
    );
    expect(hex(f)).toBe('02 00 5e 10 00 01 02 00 5e 10 00 24 08 00 aa');
    expect(decodeEthernet(f).header).toEqual({
      dst: '02:00:5e:10:00:01',
      src: '02:00:5e:10:00:24',
      etherType: 0x0800,
    });
  });
});

describe('IPv4', () => {
  it('reproduces the classic header checksum example (0xb861)', () => {
    const payload = new Uint8Array(0x73 - 20);
    const p = encodeIpv4(
      { dscp: 0, id: 0, df: true, ttl: 64, protocol: 17, src: '192.168.0.1', dst: '192.168.0.199' },
      payload,
    );
    expect(hex(p.subarray(0, 20))).toBe(
      '45 00 00 73 00 00 40 00 40 11 b8 61 c0 a8 00 01 c0 a8 00 c7',
    );
    const d = decodeIpv4(p, 0);
    expect(d.checksumOk).toBe(true);
    expect(d.header.ttl).toBe(64);
  });

  it('detects a corrupted header', () => {
    const p = encodeIpv4(
      { dscp: 0, id: 1, df: true, ttl: 64, protocol: 6, src: '10.0.0.1', dst: '10.0.0.2' },
      new Uint8Array(4),
    );
    p[8] = 63; // TTL changed without fixing the checksum
    expect(decodeIpv4(p, 0).checksumOk).toBe(false);
  });
});

describe('UDP', () => {
  it('computes the pseudo-header checksum (hand-checked 0x856e)', () => {
    const seg = encodeUdp('10.0.0.1', '10.0.0.2', { srcPort: 1234, dstPort: 53 }, asciiBytes('ab'));
    expect(hex(seg)).toBe('04 d2 00 35 00 0a 85 6e 61 62');
    expect(decodeUdp(seg, 0, seg.length, '10.0.0.1', '10.0.0.2').checksumOk).toBe(true);
  });
});

describe('TCP', () => {
  it('encodes a SYN with MSS, window scale and SACK-permitted (hand-checked 0x9e61)', () => {
    const seg = encodeTcp(
      '10.0.0.1',
      '10.0.0.2',
      {
        srcPort: 0xc000,
        dstPort: 443,
        seq: 1,
        ack: 0,
        flags: flags({ syn: true }),
        window: 64240,
        urgent: 0,
        options: [
          { kind: 'mss', value: 1460 },
          { kind: 'nop' },
          { kind: 'wscale', shift: 7 },
          { kind: 'nop' },
          { kind: 'nop' },
          { kind: 'sack-permitted' },
        ],
      },
      new Uint8Array(0),
    );
    expect(hex(seg)).toBe(
      'c0 00 01 bb 00 00 00 01 00 00 00 00 80 02 fa f0 9e 61 00 00 02 04 05 b4 01 03 03 07 01 01 04 02',
    );
    const d = decodeTcp(seg, 0, seg.length, '10.0.0.1', '10.0.0.2');
    expect(d.checksumOk).toBe(true);
    expect(d.header.options).toHaveLength(6);
    expect(d.headerLen).toBe(32);
  });
});

describe('DNS', () => {
  const query: DnsMessage = {
    id: 0x1234,
    flags: { qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, rcode: 0 },
    questions: [{ name: 'example.com', type: DNS_TYPE_A, cls: DNS_CLASS_IN }],
    answers: [],
    authority: [],
    additional: [],
  };

  it('encodes an A query with length-prefixed labels', () => {
    expect(hex(encodeDns(query))).toBe(
      '12 34 01 00 00 01 00 00 00 00 00 00 07 65 78 61 6d 70 6c 65 03 63 6f 6d 00 00 01 00 01',
    );
  });

  it('compresses the answer name to a pointer at offset 12 (0xc00c)', () => {
    const r: DnsMessage = {
      ...query,
      flags: { ...query.flags, qr: true, ra: true },
      answers: [
        {
          name: 'example.com',
          type: DNS_TYPE_A,
          cls: DNS_CLASS_IN,
          ttl: 3600,
          data: { kind: 'A', address: '203.0.113.10' },
        },
      ],
    };
    const b = encodeDns(r);
    expect(hex(b.subarray(29))).toBe('c0 0c 00 01 00 01 00 00 0e 10 00 04 cb 00 71 0a');
    const d = decodeDns(b);
    expect(d.message.answers[0]).toEqual(r.answers[0]);
  });

  it('compresses names inside NS records and decodes them back', () => {
    const r: DnsMessage = {
      ...query,
      flags: { ...query.flags, qr: true },
      authority: [
        {
          name: 'example.com',
          type: DNS_TYPE_NS,
          cls: DNS_CLASS_IN,
          ttl: 172800,
          data: { kind: 'NS', host: 'ns1.example.com' },
        },
      ],
    };
    const b = encodeDns(r);
    // "ns1" label followed by a pointer back to "example.com" at offset 12
    expect(hex(b)).toContain('03 6e 73 31 c0 0c');
    expect(decodeDns(b).message.authority[0]).toEqual(r.authority[0]);
  });

  it('rejects compression loops', () => {
    const b = fromHex('0000 0000 0001 0000 0000 0000 c00c 0001 0001');
    expect(() => decodeDns(b)).toThrow();
  });
});

describe('TLS', () => {
  it('frames a record with type, legacy version and length', () => {
    expect(hex(encodeRecord(22, Uint8Array.of(1, 2, 3)))).toBe('16 03 03 00 03 01 02 03');
    expect(hex(handshake(1, Uint8Array.of(9, 9)))).toBe('01 00 00 02 09 09');
  });

  it('encodes server_name as RFC 6066 requires', () => {
    const e = ext.serverName('example.com');
    expect(hex(e.data)).toBe('00 0e 00 00 0b 65 78 61 6d 70 6c 65 2e 63 6f 6d');
  });

  it('decodes a ClientHello into its fields', () => {
    const rng = createRng(1);
    const ch = clientHello({
      random: rng.bytes(32),
      sessionId: rng.bytes(32),
      cipherSuites: [0x1301, 0x1302, 0x1303],
      extensions: [
        ext.serverName('example.com'),
        ext.supportedVersionsClient([0x0304]),
        ext.keyShareClient(0x1d, rng.bytes(32)),
      ],
    });
    const [m] = decodeHandshakes(ch, 0, ch.length, 't', false);
    expect(m?.layer.name).toBe('ClientHello');
    expect(m?.layer.facts.find((f) => f.label === 'SNI')?.value).toBe('example.com');
  });

  it('builds a parseable fake certificate', () => {
    const der = fakeCertificate(
      { subject: 'example.com', issuer: 'Demo CA', san: ['example.com'], ca: false, padding: 100 },
      createRng(5),
    );
    expect(der[0]).toBe(0x30);
    expect(parseCertSummary(der)).toMatchObject({
      subject: 'example.com',
      issuer: 'Demo CA',
      notBefore: '2026-09-01',
    });
  });
});

describe('HTTP', () => {
  it('writes a request line and headers with CRLF', () => {
    const b = encodeRequest({ method: 'GET', path: '/', headers: [['Host', 'example.com']] });
    expect(new TextDecoder().decode(b)).toBe('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const layer = decodeHttp1(b, 0, b.length, 'request', null);
    expect(layer.fields[0]?.display).toBe('GET / HTTP/1.1');
  });

  it('parses a response that arrives in pieces', () => {
    const resp = encodeResponse(
      { status: 200, reason: 'OK', headers: [['content-length', '5']] },
      asciiBytes('hello'),
    );
    const p = new Http1ResponseParser();
    const a = p.feed(resp.slice(0, 10));
    expect(a.headNow).toBe(false);
    const b = p.feed(resp.slice(10));
    expect(b.headNow).toBe(true);
    expect(new TextDecoder().decode(b.body)).toBe('hello');
    expect(p.done).toBe(true);
  });

  it('reads HTTP/2 frames across chunk boundaries', () => {
    const f = h2Frame({
      type: H2_DATA,
      flags: FLAG_END_STREAM,
      streamId: 3,
      payload: asciiBytes('abc'),
    });
    expect(hex(f)).toBe('00 00 03 00 01 00 00 00 03 61 62 63');
    const r = new H2FrameReader(false);
    expect(r.feed(f.slice(0, 5))).toEqual([]);
    const frames = r.feed(f.slice(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.streamId).toBe(3);
  });
});
