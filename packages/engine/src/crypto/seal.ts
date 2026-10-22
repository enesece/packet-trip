import { ByteWriter, concatBytes } from '../bytes/writer';
import type { PlannedRecord, PlannedWrite } from '../content/plan';
import { CT_CCS, encodeRecord } from '../proto/tls';
import type { SealedRecord, SealedWrite } from './types';

export interface RecordCipherInput {
  readonly side: 'client' | 'server';
  readonly epoch: 'handshake' | 'application';
  readonly seqNum: number;
  /** TLS 1.3: the 5-byte header used as AAD. TLS 1.2: the 13-byte pseudo-header. */
  readonly aad: Uint8Array;
  /** TLS 1.3: content || inner type. TLS 1.2: content. */
  readonly inner: Uint8Array;
}

/** Returns ciphertext || 16-byte tag for a record. */
export type RecordCipher = (input: RecordCipherInput) => Uint8Array;

interface Counters {
  hs: number;
  app: number;
  /** TLS 1.2: the CCS switches this side to encrypted records. */
  encrypted: boolean;
}

/**
 * Assigns key epochs and sequence numbers to each planned record and lays out its wire bytes.
 * `cipher` produces the encrypted body; it is either simulated (PRNG) or real AES-GCM.
 */
export class Sealer {
  private readonly counters: Record<'client' | 'server', Counters> = {
    client: { hs: 0, app: 0, encrypted: false },
    server: { hs: 0, app: 0, encrypted: false },
  };

  constructor(
    private readonly version: '1.2' | '1.3',
    private readonly explicitNonce: (side: 'client' | 'server', seq: number) => Uint8Array,
  ) {}

  /** Plans which epoch/seq each record uses, without encrypting yet. */
  assign(
    w: PlannedWrite,
    appPhase: boolean,
  ): { rec: PlannedRecord; epoch: SealedRecord['epoch']; seqNum: number }[] {
    const c = this.counters[w.side];
    return w.records.map((rec) => {
      if (!rec.encrypted) {
        if (rec.outerType === CT_CCS) c.encrypted = true;
        return { rec, epoch: 'plain' as const, seqNum: 0 };
      }
      if (this.version === '1.3') {
        if (appPhase) return { rec, epoch: 'application' as const, seqNum: c.app++ };
        return { rec, epoch: 'handshake' as const, seqNum: c.hs++ };
      }
      // TLS 1.2 uses one sequence space after ChangeCipherSpec: Finished is 0, app data continues.
      return { rec, epoch: 'application' as const, seqNum: c.app++ };
    });
  }

  layout(
    side: 'client' | 'server',
    a: { rec: PlannedRecord; epoch: SealedRecord['epoch']; seqNum: number },
  ): { header: Uint8Array; input: RecordCipherInput | null; bodyLen: number } {
    const { rec, epoch, seqNum } = a;
    if (!rec.encrypted || epoch === 'plain') {
      return { header: new Uint8Array(0), input: null, bodyLen: rec.plaintext.length };
    }
    if (this.version === '1.3') {
      const inner = concatBytes([rec.plaintext, Uint8Array.of(rec.innerType)]);
      const len = inner.length + 16;
      const header = new ByteWriter(5).u8(rec.outerType).u16(0x0303).u16(len).finish();
      return { header, input: { side, epoch, seqNum, aad: header, inner }, bodyLen: len };
    }
    const len = 8 + rec.plaintext.length + 16;
    const header = new ByteWriter(5).u8(rec.outerType).u16(0x0303).u16(len).finish();
    const aad = new ByteWriter(13)
      .u32(0)
      .u32(seqNum)
      .u8(rec.outerType)
      .u16(0x0303)
      .u16(rec.plaintext.length)
      .finish();
    return { header, input: { side, epoch, seqNum, aad, inner: rec.plaintext }, bodyLen: len };
  }

  finishRecord(
    side: 'client' | 'server',
    a: { rec: PlannedRecord; epoch: SealedRecord['epoch']; seqNum: number },
    header: Uint8Array,
    sealed: Uint8Array | null,
  ): SealedRecord {
    const { rec, epoch, seqNum } = a;
    let bytes: Uint8Array;
    if (sealed === null) bytes = encodeRecord(rec.outerType, rec.plaintext);
    else if (this.version === '1.3') bytes = concatBytes([header, sealed]);
    else bytes = concatBytes([header, this.explicitNonce(side, seqNum), sealed]);
    return { ...rec, bytes, epoch, seqNum };
  }
}

export function sealWriteSync(
  sealer: Sealer,
  w: PlannedWrite,
  appPhase: boolean,
  cipher: RecordCipher,
): SealedWrite {
  const records = sealer.assign(w, appPhase).map((a) => {
    const { header, input } = sealer.layout(w.side, a);
    return sealer.finishRecord(w.side, a, header, input ? cipher(input) : null);
  });
  return { ...w, records, bytes: concatBytes(records.map((r) => r.bytes)) };
}

export async function sealWriteAsync(
  sealer: Sealer,
  w: PlannedWrite,
  appPhase: boolean,
  cipher: (input: RecordCipherInput) => Promise<Uint8Array>,
): Promise<SealedWrite> {
  const assigned = sealer.assign(w, appPhase);
  const records = await Promise.all(
    assigned.map(async (a) => {
      const { header, input } = sealer.layout(w.side, a);
      return sealer.finishRecord(w.side, a, header, input ? await cipher(input) : null);
    }),
  );
  return { ...w, records, bytes: concatBytes(records.map((r) => r.bytes)) };
}
