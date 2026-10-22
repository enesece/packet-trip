/** mulberry32: tiny, fast, seedable 32-bit PRNG. Every random value in the engine comes from here. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a label, mixed with a seed — used to derive independent sub-streams. */
export function hashSeed(seed: number, label: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  u16(): number;
  u32(): number;
  bytes(n: number): Uint8Array;
  /** A new, independent stream derived from this stream's seed and a label. */
  fork(label: string): Rng;
  readonly seed: number;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const rng: Rng = {
    seed: seed >>> 0,
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    u16() {
      return Math.floor(next() * 0x10000);
    },
    u32() {
      return Math.floor(next() * 0x100000000) >>> 0;
    },
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
    fork(label) {
      return createRng(hashSeed(seed, label));
    },
  };
  return rng;
}
