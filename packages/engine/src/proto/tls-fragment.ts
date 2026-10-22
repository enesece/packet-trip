import type { DecryptedRecord, LayerNode } from '../model';
import { concatBytes } from '../bytes/writer';
import { hexPreview } from '../bytes/hex';
import { FieldCollector, msg } from './fields';
import {
  CONTENT_TYPE_NAMES,
  CT_CCS,
  CT_HANDSHAKE,
  decodeHandshakes,
  recordHeaderFields,
} from './tls';
import { decodeHttp1 } from './http1';
import { decodeHttp2 } from './http2';
import type { SealedRecord } from '../crypto/types';

export interface FragmentSpan {
  /** Absolute offset in the frame where this record starts (may be before the payload). */
  readonly absStart: number;
  readonly absEnd: number;
  readonly index: number;
  readonly rec: SealedRecord;
}

export interface TlsFragmentResult {
  readonly layers: LayerNode[];
  readonly decrypted: DecryptedRecord[];
  /** Raw pieces in order, for the round-trip check. */
  readonly pieces: Uint8Array[];
}

/**
 * Decodes the TLS bytes carried by one TCP segment. Record headers are parsed from the bytes; the
 * spans only tell us how many leading bytes continue an earlier record (stream reassembly info).
 */
export function decodeTlsFragment(
  b: Uint8Array,
  ps: number,
  pe: number,
  spans: readonly FragmentSpan[],
  version: '1.2' | '1.3',
): TlsFragmentResult {
  const layers: LayerNode[] = [];
  const decrypted: DecryptedRecord[] = [];
  const pieces: Uint8Array[] = [];
  const firstHeader = spans.find((s) => s.absStart >= ps);
  let pos = ps;
  const lead = spans.find((s) => s.absStart < ps && s.absEnd > ps);
  if (lead) {
    const end = Math.min(lead.absEnd, pe);
    const fc = new FieldCollector(b);
    const offIn = ps - lead.absStart;
    const total = lead.absEnd - lead.absStart;
    fc.add(
      `tls.cont.${lead.index}.data`,
      lead.rec.encrypted ? 'Encrypted data (continued)' : 'Handshake data (continued)',
      ps,
      end,
      `${end - ps} bytes · ${offIn}–${offIn + (end - ps)} of ${total}`,
      lead.rec.encrypted ? 'm.tls.cont.enc' : 'm.tls.cont.plain',
      { n: end - ps, from: offIn, to: offIn + (end - ps), total, label: lead.rec.label },
      { key: lead.rec.encrypted ? 'field.tls.cont.enc' : 'field.tls.cont.plain' },
    );
    fc.fact('record', `#${lead.index + 1} (cont.)`);
    layers.push(
      fc.layer(
        `tls.cont.${lead.index}`,
        'TLS record (continued)',
        'security',
        ps,
        end,
        msg('s.tls.cont', { label: lead.rec.label }),
        3,
      ),
    );
    if (lead.rec.encrypted) decrypted.push(decryptedFor(lead, ps, end, version));
    pieces.push(b.slice(ps, end));
    pos = end;
  }
  if (!firstHeader && !lead) {
    pieces.push(b.slice(ps, pe));
    return { layers, decrypted, pieces };
  }
  while (pos < pe) {
    const span = spans.find((s) => s.absStart === pos);
    if (pe - pos < 5 || !span) {
      // Not enough bytes for a header, or no record starts here: show raw.
      const fc = new FieldCollector(b);
      fc.add('tls.raw', 'Unparsed bytes', pos, pe, `${pe - pos} bytes`, 'm.tls.raw');
      layers.push(fc.layer('tls.raw', 'TLS (partial)', 'security', pos, pe, msg('s.tls.raw'), 3));
      pieces.push(b.slice(pos, pe));
      break;
    }
    const idp = `tls.r${span.index}`;
    const fc = new FieldCollector(b);
    const hdr = recordHeaderFields(fc, b, pos, idp, span.rec.encrypted);
    const bodyStart = pos + 5;
    const recEnd = bodyStart + hdr.length;
    const visEnd = Math.min(recEnd, pe);
    const complete = recEnd <= pe;
    const children: LayerNode[] = [];
    const tn = CONTENT_TYPE_NAMES[hdr.type] ?? String(hdr.type);
    if (span.rec.encrypted) {
      if (version === '1.2') {
        const nonceEnd = Math.min(bodyStart + 8, visEnd);
        fc.add(
          `${idp}.nonce`,
          'Explicit nonce',
          bodyStart,
          nonceEnd,
          hexPreview(b, bodyStart, nonceEnd, 8),
          'm.tls.nonce12',
          undefined,
          { expert: true },
        );
      }
      const ctStart = version === '1.2' ? bodyStart + 8 : bodyStart;
      const tagStart = recEnd - 16;
      const ctEnd = Math.min(tagStart, visEnd);
      if (ctEnd > ctStart) {
        fc.add(
          `${idp}.enc`,
          'Encrypted data',
          ctStart,
          ctEnd,
          hexPreview(b, ctStart, ctEnd, 8),
          'm.tls.ciphertext',
          {
            n: ctEnd - ctStart,
            total: tagStart - ctStart,
          },
        );
      }
      if (visEnd > tagStart) {
        fc.add(
          `${idp}.tag`,
          'Authentication tag',
          Math.max(tagStart, ctStart),
          visEnd,
          hexPreview(b, Math.max(tagStart, ctStart), visEnd, 8),
          'm.tls.tag',
        );
      }
      fc.fact('type', `${hdr.type} (${tn})`);
      fc.fact('length', `${hdr.length} B`);
      fc.fact('encrypted', span.rec.label);
      decrypted.push(decryptedFor(span, pos, visEnd, version));
    } else if (hdr.type === CT_CCS) {
      fc.add(`${idp}.ccs`, 'Change cipher spec', bodyStart, visEnd, '1', 'm.tls.ccs');
      fc.fact('type', 'change_cipher_spec');
    } else if (hdr.type === CT_HANDSHAKE && complete) {
      for (const h of decodeHandshakes(b, bodyStart, recEnd, idp, version === '1.2'))
        children.push({ ...h.layer, depth: 4 });
      fc.fact('type', `${hdr.type} (${tn})`);
      fc.fact('length', `${hdr.length} B`);
    } else {
      fc.add(
        `${idp}.frag`,
        'Handshake data (first part)',
        bodyStart,
        visEnd,
        `${visEnd - bodyStart} of ${hdr.length} bytes`,
        'm.tls.frag',
        {
          n: visEnd - bodyStart,
          total: hdr.length,
          label: span.rec.label,
        },
      );
      fc.fact('type', `${hdr.type} (${tn})`);
      fc.fact('length', `${hdr.length} B`);
    }
    if (!complete) fc.fact('continues', `${recEnd - pe} B in next packet`);
    const name = span.rec.encrypted ? 'TLS record (encrypted)' : 'TLS record';
    layers.push(
      fc.layer(
        idp,
        name,
        'security',
        pos,
        visEnd,
        span.rec.encrypted
          ? msg('s.tls.rec.enc', { len: hdr.length, label: span.rec.label })
          : msg('s.tls.rec', { type: tn, len: hdr.length, label: span.rec.label }),
        3,
      ),
    );
    layers.push(...children);
    pieces.push(b.slice(pos, visEnd));
    pos = visEnd;
  }
  return { layers, decrypted, pieces };
}

function decryptedFor(
  span: FragmentSpan,
  visStart: number,
  visEnd: number,
  version: '1.2' | '1.3',
): DecryptedRecord {
  const rec = span.rec;
  const plaintext = rec.plaintext;
  const inner =
    version === '1.3' ? concatBytes([plaintext, Uint8Array.of(rec.innerType)]) : plaintext;
  const layers: LayerNode[] = [];
  try {
    if (rec.innerType === CT_HANDSHAKE) {
      for (const h of decodeHandshakes(
        inner,
        0,
        plaintext.length,
        `dec${span.index}`,
        version === '1.2',
      ))
        layers.push({ ...h.layer, depth: 4 });
    } else if (rec.http) {
      if (rec.http.part === 'h2') {
        const streams = rec.http.streams ?? {};
        layers.push({
          ...decodeHttp2(inner, 0, plaintext.length, {
            resource: (id) => streams[id]?.resource ?? '',
            contentType: (id) => streams[id]?.contentType ?? '',
          }),
          depth: 4,
        });
      } else {
        layers.push({
          ...decodeHttp1(inner, 0, plaintext.length, rec.http.part, {
            resource: rec.http.resource,
            contentType: rec.http.contentType,
            bodyOffset: rec.http.bodyOffset,
            bodyTotal: rec.http.bodyTotal,
          }),
          depth: 4,
        });
      }
    }
  } catch {
    // Leave layers empty; the UI still shows the plaintext bytes.
  }
  if (version === '1.3') {
    const fc = new FieldCollector(inner);
    const n = plaintext.length;
    fc.add(
      `dec${span.index}.innertype`,
      'Real content type',
      n,
      n + 1,
      `${rec.innerType} (${CONTENT_TYPE_NAMES[rec.innerType] ?? '?'})`,
      'm.tls.innertype',
      {
        type: CONTENT_TYPE_NAMES[rec.innerType] ?? '?',
      },
    );
    layers.push(
      fc.layer(
        `dec${span.index}.inner`,
        'TLSInnerPlaintext',
        'security',
        n,
        n + 1,
        msg('s.tls.inner'),
        4,
      ),
    );
  }
  return {
    recordIndex: span.index,
    ciphertextRange: [visStart, visEnd],
    plaintext: inner,
    innerType: rec.innerType,
    layers,
    complete: span.absStart >= visStart && span.absEnd <= visEnd,
  };
}
