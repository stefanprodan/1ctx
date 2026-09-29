/**
 * (1ctx) diff's compare, written from Myers, "An O(ND) Difference
 * Algorithm and Its Variations" (Algorithmica 1, 1986): the middle-snake
 * search in linear space over lines interned to numbers, with GNU diff's
 * manual as the guide to what it does around the search. The common head
 * and tail are trimmed, lines found in one file only are set aside, a
 * search past a cost growing with the square root of the input times its
 * box settles for the point that reached furthest, and past `giveUp`
 * steps in all the boxes left are taken whole, unless `minimal`. Every
 * step is charged, and change groups then slide to where GNU puts them.
 */

export interface CompareOptions {
  /** -d: the smallest answer however long it takes */
  minimal?: boolean;
  /** --speed-large-files: settle for a near answer sooner */
  speedLargeFiles?: boolean;
  /** --horizon-lines: common lines at each end the search still sees */
  horizon?: number;
  /** steps after which the boxes left are taken whole, unless minimal */
  giveUp?: number;
  /** takes the steps spent; throws to stop the compare */
  charge: (steps: number) => void;
}

export interface Comparison {
  /** 1 for each line of the first file that is not in the answer's matches */
  deleted: Uint8Array;
  /** 1 for each line of the second file that is not in them */
  inserted: Uint8Array;
}

/** The cost past which a search settles, unless `minimal`. */
export function costBound(lines: number, speedLargeFiles = false): number {
  let bound = 256;
  while (bound * bound < lines) bound *= 2;
  return speedLargeFiles ? Math.max(64, bound >> 2) : bound;
}

/**
 * Compares two files whose lines are numbers, equal lines equal numbers
 * below `count`.
 */
export function compare(
  a: Int32Array,
  b: Int32Array,
  count: number,
  options: CompareOptions,
): Comparison {
  const n = a.length;
  const m = b.length;
  const deleted = new Uint8Array(n);
  const inserted = new Uint8Array(m);
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < n - head &&
    tail < m - head &&
    a[n - 1 - tail] === b[m - 1 - tail]
  ) {
    tail++;
  }
  options.charge(head + tail + 1);
  const horizon = Math.max(0, options.horizon ?? 0);
  const x0 = Math.max(0, head - horizon);
  const keep = Math.max(0, tail - horizon);
  const x1 = n - keep;
  const y1 = m - keep;

  // a line the other side lacks can match nothing: it is a change, and the
  // search never sees it
  const inA = new Int32Array(count);
  const inB = new Int32Array(count);
  for (let x = x0; x < x1; x++) inA[a[x]]++;
  for (let y = x0; y < y1; y++) inB[b[y]]++;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = x0; x < x1; x++) {
    if (inB[a[x]] > 0) xs.push(x);
    else deleted[x] = 1;
  }
  for (let y = x0; y < y1; y++) {
    if (inA[b[y]] > 0) ys.push(y);
    else inserted[y] = 1;
  }
  options.charge(x1 - x0 + y1 - x0);

  const sa = Int32Array.from(xs, (x) => a[x]);
  const sb = Int32Array.from(ys, (y) => b[y]);
  const search = options.minimal
    ? new Search(sa, sb, Infinity, Infinity, options.charge)
    : new Search(
        sa,
        sb,
        costBound(n + m, options.speedLargeFiles),
        options.giveUp ?? Infinity,
        options.charge,
      );
  search.run();
  for (let i = 0; i < sa.length; i++) if (search.deleted[i]) deleted[xs[i]] = 1;
  for (let j = 0; j < sb.length; j++) if (search.inserted[j]) inserted[ys[j]] = 1;

  // groups never slide into the common head and tail the search left out
  slide(a, deleted, inserted, x0, x1, options.charge);
  slide(b, inserted, deleted, x0, y1, options.charge);
  return { deleted, inserted };
}

const FAR = 0x7fffffff;

class Search {
  readonly deleted: Uint8Array;
  readonly inserted: Uint8Array;
  private readonly fv: Int32Array;
  private readonly bv: Int32Array;
  private readonly offset: number;
  private total = 0;
  private charged = 0;

  constructor(
    private readonly a: Int32Array,
    private readonly b: Int32Array,
    private readonly bound: number,
    private readonly giveUp: number,
    private readonly charge: (steps: number) => void,
  ) {
    this.deleted = new Uint8Array(a.length);
    this.inserted = new Uint8Array(b.length);
    this.offset = b.length + 1;
    this.fv = new Int32Array(a.length + b.length + 3);
    this.bv = new Int32Array(a.length + b.length + 3);
  }

  run(): void {
    const { a, b } = this;
    const boxes = [0, a.length, 0, b.length];
    while (boxes.length > 0) {
      let y1 = boxes.pop() as number;
      let y0 = boxes.pop() as number;
      let x1 = boxes.pop() as number;
      let x0 = boxes.pop() as number;
      while (x0 < x1 && y0 < y1 && a[x0] === b[y0]) {
        x0++;
        y0++;
      }
      while (x0 < x1 && y0 < y1 && a[x1 - 1] === b[y1 - 1]) {
        x1--;
        y1--;
      }
      if (x0 === x1) {
        this.inserted.fill(1, y0, y1);
        continue;
      }
      if (y0 === y1) {
        this.deleted.fill(1, x0, x1);
        continue;
      }
      const snake =
        this.total < this.giveUp ? this.middleSnake(x0, x1, y0, y1) : null;
      if (!snake) {
        this.deleted.fill(1, x0, x1);
        this.inserted.fill(1, y0, y1);
        continue;
      }
      const [xs, ys, xe, ye] = snake;
      boxes.push(xe, x1, ye, y1, x0, xs, y0, ys);
    }
    this.flush();
  }

  private flush(): void {
    if (this.total > this.charged) {
      const steps = this.total - this.charged;
      this.charged = this.total;
      this.charge(steps);
    }
  }

  /**
   * The snake in the middle of a shortest path through the box, as its
   * start and end; past the bound, a point the furthest path reached;
   * past `giveUp`, null. Diagonal k is x - y, stored at k + offset.
   */
  private middleSnake(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): [number, number, number, number] | null {
    const { a, b, fv, bv } = this;
    const o = this.offset;
    const kmin = x0 - y1;
    const kmax = x1 - y0;
    const fmid = x0 - y0;
    const bmid = x1 - y1;
    const odd = ((fmid - bmid) & 1) !== 0;
    const begin = this.total;
    // past this many steps the search settles, which bounds a compare near
    // N^1.5 log N as GNU's manual has it
    const budget = this.bound * (x1 - x0 + y1 - y0);

    let fmin = fmid;
    let fmax = fmid;
    let pfmin = 1;
    let pfmax = 0;
    let bmin = bmid;
    let bmax = bmid;
    let pbmin = 1;
    let pbmax = 0;
    {
      let x = x0;
      while (x < x1 && x - fmid < y1 && a[x] === b[x - fmid]) x++;
      fv[fmid + o] = x;
      let u = x1;
      while (u > x0 && u - bmid > y0 && a[u - 1] === b[u - 1 - bmid]) u--;
      bv[bmid + o] = u;
      this.total += x - x0 + x1 - u + 2;
    }

    for (let d = 1; ; d++) {
      // forward: the furthest point on each diagonal with d changes
      const lo = fmin;
      const hi = fmax;
      const nlo = lo > kmin ? lo - 1 : lo + 1;
      const nhi = hi < kmax ? hi + 1 : hi - 1;
      // from the top diagonal down, which picks among equal answers as GNU
      for (let k = nhi; k >= nlo; k -= 2) {
        let x = -1;
        if (k - 1 >= lo && k - 1 <= hi) {
          const from = fv[k - 1 + o];
          if (from >= 0 && from + 1 <= x1) x = from + 1;
        }
        if (k + 1 >= lo && k + 1 <= hi) {
          const from = fv[k + 1 + o];
          if (from >= 0 && from - k <= y1 && from > x) x = from;
        }
        if (k >= pfmin && k <= pfmax && fv[k + o] > x) x = fv[k + o];
        if (x < 0) {
          fv[k + o] = -1;
          continue;
        }
        const sx = x;
        let y = x - k;
        while (x < x1 && y < y1 && a[x] === b[y]) {
          x++;
          y++;
        }
        fv[k + o] = x;
        this.total += x - sx + 1;
        if (odd && k >= bmin && k <= bmax) {
          const back = bv[k + o];
          if (back !== FAR && x >= back) {
            this.flush();
            return [sx, sx - k, x, y];
          }
        }
      }
      pfmin = lo;
      pfmax = hi;
      fmin = nlo;
      fmax = nhi;

      // backward, from the box's far corner
      const blo = bmin;
      const bhi = bmax;
      const nblo = blo > kmin ? blo - 1 : blo + 1;
      const nbhi = bhi < kmax ? bhi + 1 : bhi - 1;
      for (let k = nbhi; k >= nblo; k -= 2) {
        let x = FAR;
        if (k + 1 >= blo && k + 1 <= bhi) {
          const from = bv[k + 1 + o];
          if (from !== FAR && from - 1 >= x0) x = from - 1;
        }
        if (k - 1 >= blo && k - 1 <= bhi) {
          const from = bv[k - 1 + o];
          if (from !== FAR && from - k >= y0 && from < x) x = from;
        }
        if (k >= pbmin && k <= pbmax && bv[k + o] < x) x = bv[k + o];
        if (x === FAR) {
          bv[k + o] = FAR;
          continue;
        }
        const sx = x;
        let y = x - k;
        while (x > x0 && y > y0 && a[x - 1] === b[y - 1]) {
          x--;
          y--;
        }
        bv[k + o] = x;
        this.total += sx - x + 1;
        if (!odd && k >= fmin && k <= fmax) {
          const forth = fv[k + o];
          if (forth >= 0 && forth >= x) {
            this.flush();
            return [x, y, sx, sx - k];
          }
        }
      }
      pbmin = blo;
      pbmax = bhi;
      bmin = nblo;
      bmax = nbhi;

      if (this.total - this.charged >= 4096) this.flush();
      if (this.total > this.giveUp) {
        this.flush();
        return null;
      }
      if (this.total - begin > budget) {
        const split = this.furthest(x0, x1, y0, y1, fmin, fmax, bmin, bmax);
        if (split) {
          this.flush();
          return [split[0], split[1], split[0], split[1]];
        }
      }
    }
  }

  /** The point that made the most progress from either corner. */
  private furthest(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    fmin: number,
    fmax: number,
    bmin: number,
    bmax: number,
  ): [number, number] | null {
    const { fv, bv } = this;
    const o = this.offset;
    let best: [number, number] | null = null;
    let progress = 0;
    for (let k = fmin; k <= fmax; k += 2) {
      const x = fv[k + o];
      if (x < 0) continue;
      const y = x - k;
      const p = x + y - x0 - y0;
      if (p > progress && !(x === x1 && y === y1)) {
        progress = p;
        best = [x, y];
      }
    }
    for (let k = bmin; k <= bmax; k += 2) {
      const x = bv[k + o];
      if (x === FAR) continue;
      const y = x - k;
      const p = x1 + y1 - x - y;
      if (p > progress && !(x === x0 && y === y0)) {
        progress = p;
        best = [x, y];
      }
    }
    this.total += fmax - fmin + bmax - bmin + 2;
    return best;
  }
}

/**
 * Slides each group of changed lines in `changed` over equal lines within
 * lo and hi: up then down as far as it goes, merging with the groups it
 * meets, and settles where it lines up with a change in the other file,
 * or else as late as it can.
 */
function slide(
  lines: Int32Array,
  changed: Uint8Array,
  other: Uint8Array,
  lo: number,
  hi: number,
  charge: (steps: number) => void,
): void {
  const n = changed.length;
  const m = other.length;
  let steps = 0;
  let i = 0;
  let j = 0;
  for (;;) {
    while (j < m && other[j]) j++;
    while (i < n && !changed[i]) {
      i++;
      j++;
      while (j < m && other[j]) j++;
    }
    if (i >= n) break;
    let start = i;
    let end = i;
    while (end < n && changed[end]) end++;
    // j is the other file's line matched with the first after the group
    let length: number;
    let aligned: number;
    do {
      length = end - start;
      while (start > lo && lines[start - 1] === lines[end - 1]) {
        changed[--start] = 1;
        changed[--end] = 0;
        while (start > 0 && changed[start - 1]) start--;
        do j--;
        while (other[j]);
        steps++;
      }
      aligned = j > 0 && other[j - 1] ? end : -1;
      while (end < hi && lines[start] === lines[end]) {
        changed[start++] = 0;
        changed[end++] = 1;
        while (end < n && changed[end]) end++;
        do j++;
        while (j < m && other[j]);
        if (j > 0 && other[j - 1]) aligned = end;
        steps++;
      }
    } while (length !== end - start);
    if (aligned !== -1) {
      while (end > aligned) {
        changed[--start] = 1;
        changed[--end] = 0;
        do j--;
        while (other[j]);
        steps++;
      }
    }
    i = end;
    steps += end - start;
  }
  charge(steps + n);
}
