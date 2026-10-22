import { ByteReader, DecodeError } from '../bytes/reader';
import { ByteWriter, asciiBytes, bytesToAscii, utf8Decode } from '../bytes/writer';
import type { Field, LayerNode } from '../model';
import { FieldCollector, msg } from './fields';
import type { Header } from './http1';

/**
 * HTTP/2, simplified: real 9-byte frame headers, stream ids and flags, but header blocks are
 * plain "name: value" text instead of HPACK. The UI labels this as simplified.
 */
export const H2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
export const H2_DATA = 0x0;
export const H2_HEADERS = 0x1;
export const H2_SETTINGS = 0x4;
export const FLAG_END_STREAM = 0x1;
export const FLAG_ACK = 0x1;
export const FLAG_END_HEADERS = 0x4;

export interface H2Frame {
  readonly type: number;
  readonly flags: number;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(f: H2Frame): Uint8Array {
  return new ByteWriter(9 + f.payload.length)
    .u24(f.payload.length)
    .u8(f.type)
    .u8(f.flags)
    .u32(f.streamId & 0x7fffffff)
    .bytes(f.payload)
    .finish();
}

export function headerBlock(headers: readonly Header[]): Uint8Array {
  return asciiBytes(headers.map(([n, v]) => `${n}: ${v}\n`).join(''));
}

export function parseHeaderBlock(b: Uint8Array): Header[] {
  return bytesToAscii(b)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const c = l.indexOf(':', 1);
      return [l.slice(0, c), l.slice(c + 1).trim()] as const;
    });
}

export function settingsFrame(ack: boolean): Uint8Array {
  if (ack)
    return encodeFrame({
      type: H2_SETTINGS,
      flags: FLAG_ACK,
      streamId: 0,
      payload: new Uint8Array(0),
    });
  // SETTINGS_MAX_CONCURRENT_STREAMS = 100, SETTINGS_INITIAL_WINDOW_SIZE = 6291456
  const p = new ByteWriter(12).u16(0x3).u32(100).u16(0x4).u32(6291456).finish();
  return encodeFrame({ type: H2_SETTINGS, flags: 0, streamId: 0, payload: p });
}

const TYPE_NAMES: Record<number, string> = { 0: 'DATA', 1: 'HEADERS', 4: 'SETTINGS' };

export interface H2StreamInfo {
  readonly resource: (streamId: number) => string;
  readonly contentType: (streamId: number) => string;
}

export function decodeHttp2(
  b: Uint8Array,
  start: number,
  end: number,
  info: H2StreamInfo | null,
): LayerNode {
  const fc = new FieldCollector(b);
  let pos = start;
  const names: string[] = [];
  if (end - start >= 24 && bytesToAscii(b.subarray(start, start + 24)) === H2_PREFACE) {
    fc.add('h2.preface', 'Connection preface', start, start + 24, 'PRI * HTTP/2.0', 'm.h2.preface');
    names.push('preface');
    pos += 24;
  }
  let i = 0;
  while (pos < end) {
    const r = new ByteReader(b, pos, end);
    const len = r.u24();
    const type = r.u8();
    const flags = r.u8();
    const streamId = r.u32() & 0x7fffffff;
    if (pos + 9 + len > end) throw new DecodeError('HTTP/2 frame runs past the record');
    const tn = TYPE_NAMES[type] ?? `TYPE${type}`;
    const ps = pos + 9;
    const children: Field[] = [
      fc.make(
        `h2.f.${i}.len`,
        'Length',
        pos,
        pos + 3,
        `${len} bytes`,
        'm.h2.len',
        { len },
        { expert: true },
      ),
      fc.make(
        `h2.f.${i}.type`,
        'Type',
        pos + 3,
        pos + 4,
        `${type} (${tn})`,
        `m.h2.type.${tn.toLowerCase()}`,
      ),
      fc.make(`h2.f.${i}.flags`, 'Flags', pos + 4, pos + 5, flagText(type, flags), 'm.h2.flags', {
        flags: flagText(type, flags),
      }),
      fc.make(
        `h2.f.${i}.stream`,
        'Stream',
        pos + 5,
        pos + 9,
        String(streamId),
        streamId === 0 ? 'm.h2.stream0' : 'm.h2.stream',
        {
          id: streamId,
          resource: info?.resource(streamId) ?? '',
        },
      ),
    ];
    let display = `${tn} · stream ${streamId}`;
    if (type === H2_HEADERS) {
      const hs = parseHeaderBlock(b.subarray(ps, ps + len));
      const path = hs.find(([n]) => n === ':path')?.[1];
      const status = hs.find(([n]) => n === ':status')?.[1];
      display = path
        ? `HEADERS · stream ${streamId} · GET ${path}`
        : `HEADERS · stream ${streamId} · ${status ?? ''}`;
      children.push(
        fc.make(
          `h2.f.${i}.block`,
          'Header block (simplified, not HPACK)',
          ps,
          ps + len,
          hs.map(([n, v]) => `${n}: ${v}`).join(' · '),
          'm.h2.block',
        ),
      );
      names.push(path ? `GET ${path}` : `${status ?? ''} ${info?.resource(streamId) ?? ''}`.trim());
    } else if (type === H2_DATA) {
      const ct = info?.contentType(streamId) ?? '';
      const preview = ct.startsWith('font/')
        ? `${len} bytes of font data`
        : utf8Decode(b.subarray(ps, Math.min(ps + 60, ps + len))).replace(/\s+/g, ' ');
      children.push(
        fc.make(`h2.f.${i}.data`, 'Data', ps, ps + len, preview, 'm.h2.data', {
          n: len,
          resource: info?.resource(streamId) ?? '',
        }),
      );
      names.push(`DATA ${info?.resource(streamId) ?? streamId}`);
    } else if (type === H2_SETTINGS) {
      display = flags & FLAG_ACK ? 'SETTINGS · ACK' : 'SETTINGS';
      if (len > 0)
        children.push(
          fc.make(
            `h2.f.${i}.settings`,
            'Settings',
            ps,
            ps + len,
            `${len / 6} settings`,
            'm.h2.settings',
          ),
        );
      names.push(display);
    }
    fc.add(
      `h2.f.${i}`,
      `Frame: ${tn}`,
      pos,
      ps + len,
      display,
      'm.h2.frame',
      { type: tn },
      { children, key: 'field.h2.frame', nameParams: { type: tn } },
    );
    pos = ps + len;
    i++;
  }
  fc.fact('frames', String(i));
  return fc.layer(
    'h2',
    'HTTP/2 (simplified)',
    'application',
    start,
    end,
    msg('s.h2', { frames: names.join(', ') }),
  );
}

function flagText(type: number, flags: number): string {
  const out: string[] = [];
  if (type === H2_SETTINGS && flags & FLAG_ACK) out.push('ACK');
  if ((type === H2_DATA || type === H2_HEADERS) && flags & FLAG_END_STREAM) out.push('END_STREAM');
  if (type === H2_HEADERS && flags & FLAG_END_HEADERS) out.push('END_HEADERS');
  return out.join(' · ') || 'none';
}

/** Incremental frame reader for the simulated browser and server. */
export class H2FrameReader {
  private buf = new Uint8Array(0);
  private prefaceSeen = false;

  constructor(private readonly expectPreface: boolean) {}

  feed(chunk: Uint8Array): H2Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let pos = 0;
    if (this.expectPreface && !this.prefaceSeen) {
      if (merged.length < 24) {
        this.buf = merged;
        return [];
      }
      pos = 24;
      this.prefaceSeen = true;
    }
    const frames: H2Frame[] = [];
    while (merged.length - pos >= 9) {
      const len =
        ((merged[pos] ?? 0) << 16) | ((merged[pos + 1] ?? 0) << 8) | (merged[pos + 2] ?? 0);
      if (merged.length - pos < 9 + len) break;
      const type = merged[pos + 3] ?? 0;
      const flags = merged[pos + 4] ?? 0;
      const streamId =
        ((((merged[pos + 5] ?? 0) & 0x7f) << 24) |
          ((merged[pos + 6] ?? 0) << 16) |
          ((merged[pos + 7] ?? 0) << 8) |
          (merged[pos + 8] ?? 0)) >>>
        0;
      frames.push({ type, flags, streamId, payload: merged.slice(pos + 9, pos + 9 + len) });
      pos += 9 + len;
    }
    this.buf = merged.slice(pos);
    return frames;
  }
}
