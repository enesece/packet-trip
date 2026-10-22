/** Virtual clock in integer microseconds. Never reads wall time. */
export class VirtualClock {
  private t = 0;

  get nowUs(): number {
    return this.t;
  }

  advanceTo(tUs: number): void {
    if (tUs < this.t) throw new Error(`clock cannot go backwards (${tUs} < ${this.t})`);
    this.t = tUs;
  }

  reset(): void {
    this.t = 0;
  }
}

export const MS = 1000;

export function ms(v: number): number {
  return Math.round(v * MS);
}
