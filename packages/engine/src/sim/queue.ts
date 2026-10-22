/** Binary min-heap keyed by (time, insertion order). Equal times pop in insertion order. */
export interface Queued<T> {
  readonly tUs: number;
  readonly order: number;
  readonly value: T;
}

export class EventQueue<T> {
  private heap: Queued<T>[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(tUs: number, value: T): void {
    const item: Queued<T> = { tUs, order: this.counter++, value };
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const parent = h[p];
      if (!parent || !less(item, parent)) break;
      h[i] = parent;
      i = p;
    }
    h[i] = item;
  }

  peek(): Queued<T> | undefined {
    return this.heap[0];
  }

  pop(): Queued<T> | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (!top || !last) return undefined;
    if (h.length === 0) return top;
    let i = 0;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      let mItem: Queued<T> = m === i ? last : (h[m] as Queued<T>);
      const li = h[l];
      if (l < n && li && less(li, mItem)) {
        m = l;
        mItem = li;
      }
      const ri = h[r];
      if (r < n && ri && less(ri, mItem)) {
        m = r;
        mItem = ri;
      }
      if (m === i) break;
      h[i] = mItem;
      i = m;
    }
    h[i] = last;
    return top;
  }

  clear(): void {
    this.heap = [];
    this.counter = 0;
  }
}

function less<T>(a: Queued<T>, b: Queued<T>): boolean {
  return a.tUs < b.tUs || (a.tUs === b.tUs && a.order < b.order);
}
