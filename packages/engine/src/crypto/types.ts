import type { CryptoMode, Msg } from '../model';
import type { PlannedRecord, PlannedWrite } from '../content/plan';

export interface SealedRecord extends PlannedRecord {
  /** The full record as it appears on the wire (header + body). */
  readonly bytes: Uint8Array;
  /** Key epoch and per-direction record sequence number used for the nonce. */
  readonly epoch: 'plain' | 'handshake' | 'application';
  readonly seqNum: number;
}

export interface SealedWrite extends Omit<PlannedWrite, 'records'> {
  readonly records: readonly SealedRecord[];
  readonly bytes: Uint8Array;
}

export interface KeyScheduleStep {
  readonly id: string;
  readonly name: string;
  /** e.g. HKDF-Extract(salt, ikm) or HKDF-Expand-Label(secret, "c hs traffic", hash) */
  readonly formula: string;
  readonly value: string;
  readonly explain: Msg;
}

export interface TrafficKey {
  readonly side: 'client' | 'server';
  readonly epoch: 'handshake' | 'application';
  readonly key: Uint8Array;
  readonly iv: Uint8Array;
}

export interface SealedConnection {
  readonly tls: '1.2' | '1.3';
  readonly http: '1.1' | '2';
  readonly mode: CryptoMode;
  /** Alternating flights, starting with the client. */
  readonly handshake: readonly SealedWrite[];
  readonly requests: readonly SealedWrite[];
  readonly responses: readonly SealedWrite[];
  readonly order: readonly string[];
  readonly h2Triggers: readonly number[];
  readonly bodies: ReadonlyMap<string, Uint8Array>;
  readonly keySchedule: readonly KeyScheduleStep[] | null;
  readonly trafficKeys: readonly TrafficKey[] | null;
}

export interface SealedOrigin {
  readonly requests: readonly SealedWrite[];
  readonly responses: readonly SealedWrite[];
  readonly paths: readonly string[];
}

/** All bytes that will travel over TLS, prepared before the event loop starts. */
export interface CryptoMaterial {
  readonly mode: CryptoMode;
  readonly main: SealedConnection;
  readonly origin: SealedOrigin;
  /** Set when real crypto was requested but unavailable. */
  readonly fallbackReason: string | null;
}
