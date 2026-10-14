// Adapted from NousResearch/hermes-agent, agent/repetition_guard.py at
// e06df9c2. MIT, Copyright (c) 2025 Nous Research.
// The complete notice is in THIRD_PARTY_LICENSES.md.
//
// A model in an exact repetition loop spends its whole output budget on
// one fragment. Only long verbatim repeats (60+ characters) covering
// most of a text count, so ordinary reuse of phrasing never does.
// Lengths are UTF-16 units where Hermes counts code points.

// below this a text is never judged: short texts repeat trivially
export const MIN_FRAGMENT_LENGTH = 400;
// the exact-repeat window, far past ordinary phrasing reuse
const REPEAT_WINDOW = 60;
// a window or line repeating this often is a signal
const MIN_REPEAT_COUNT = 5;
// dominated: repeats cover at least this share of the text
const DOMINANCE_RATIO = 0.5;
// the periodic scan's bounds keep it linear: a dominant run crosses
// many of these evenly spaced anchors
const MAX_ANCHOR_SAMPLES = 32;
const MAX_ANCHOR_MATCHES = 8;
// a runaway text with lines has at most this share distinct: distinct
// batch rows share long windows, a loop re-emits the same lines
const RUNAWAY_DISTINCT_LINE_RATIO = 0.5;
// asked-for repeats stay in the low KB; real loops run far past this
export const STREAM_MIN_CHARS = 16_000;
// one check reads at most this much of the latest text
export const STREAM_TAIL_CHARS = 4 * STREAM_MIN_CHARS;

// Python's str.splitlines() boundaries
// biome-ignore lint/suspicious/noControlCharactersInRegex: the separators splitlines() splits on.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// a contiguous run of at least five exact repeats, or one line or one
// window repeated, covers at least half of text
export function isRepetitionDominated(text: string): boolean {
  if (typeof text !== "string") return false;
  const n = text.length;
  if (n < MIN_FRAGMENT_LENGTH) return false;
  // the common echo: one line copied
  if (lineRepetitionDominated(text, n)) return true;
  // the window count takes loops whose repeats differ by a counter; the
  // periodic scan long exact units whose windows each recur too rarely
  return windowCountDominated(text, n) || periodicRunDominated(text, n);
}

function windowCountDominated(text: string, n: number): boolean {
  const needed = Math.max(
    MIN_REPEAT_COUNT,
    Math.ceil((n * DOMINANCE_RATIO) / REPEAT_WINDOW),
  );
  const counts = new Map<string, number>();
  for (let i = 0; i + REPEAT_WINDOW <= n; i++) {
    const key = text.slice(i, i + REPEAT_WINDOW);
    const c = (counts.get(key) ?? 0) + 1;
    if (c >= needed) return true;
    counts.set(key, c);
  }
  return false;
}

// A 60-character anchor matched later gives a candidate period;
// expanding text[i] === text[i + period] both ways finds the whole run,
// so coverage counts the true unit, not 60 characters a repeat
function periodicRunDominated(text: string, n: number): boolean {
  const maxStart = n - REPEAT_WINDOW;
  if (maxStart < 1) return false;
  const step = Math.max(
    1,
    Math.floor((maxStart + MAX_ANCHOR_SAMPLES - 2) / (MAX_ANCHOR_SAMPLES - 1)),
  );
  const starts: number[] = [];
  for (let s = 0; s <= maxStart; s += step) starts.push(s);
  if (starts.at(-1) !== maxStart) starts.push(maxStart);
  // runs already expanded and rejected: an anchor inside one whose
  // period is a multiple of its period would walk the same run again
  const rejected: [number, number, number][] = [];
  for (const start of starts) {
    const anchor = text.slice(start, start + REPEAT_WINDOW);
    let from = start + 1;
    for (let k = 0; k < MAX_ANCHOR_MATCHES; k++) {
      const match = text.indexOf(anchor, from);
      if (match < 0) break;
      const period = match - start;
      from = match + 1;
      if (
        rejected.some(
          ([lo, hi, p]) => lo <= start && start < hi && period % p === 0,
        )
      ) {
        continue;
      }
      const [left, right] = expandRun(text, n, start, period, REPEAT_WINDOW);
      if (
        right - left >= MIN_REPEAT_COUNT * period &&
        right - left >= n * DOMINANCE_RATIO
      ) {
        return true;
      }
      rejected.push([left, right, period]);
    }
  }
  return false;
}

// one known equal window grown to the [left, right) of its exact run
function expandRun(
  text: string,
  n: number,
  start: number,
  period: number,
  matched: number,
): [number, number] {
  let left = start;
  while (
    left > 0 &&
    text.charCodeAt(left - 1) === text.charCodeAt(left - 1 + period)
  ) {
    left--;
  }
  let right = start + matched;
  while (
    right + period < n &&
    text.charCodeAt(right) === text.charCodeAt(right + period)
  ) {
    right++;
  }
  return [left, right + period];
}

function nonEmptyLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(LINE_BREAK)) {
    const trimmed = line.trim();
    if (trimmed !== "") lines.push(trimmed);
  }
  return lines;
}

function lineRepetitionDominated(text: string, n: number): boolean {
  const counts = new Map<string, number>();
  for (const line of nonEmptyLines(text)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  for (const [line, c] of counts) {
    if (c >= MIN_REPEAT_COUNT && c * line.length >= n * DOMINANCE_RATIO) {
      return true;
    }
  }
  return false;
}

// dominated, and with five or more non-empty lines at most half of them
// distinct, so distinct batch rows that share long windows never count
export function isRunawayRepetition(text: string): boolean {
  if (!isRepetitionDominated(text)) return false;
  const lines = nonEmptyLines(text);
  // no line structure to judge by: a dominated single-line loop
  if (lines.length < MIN_REPEAT_COUNT) return true;
  return new Set(lines).size <= lines.length * RUNAWAY_DISTINCT_LINE_RATIO;
}

// The runaway check over one channel while it streams. The first check
// is at STREAM_MIN_CHARS, then the gap doubles up to one tail window
// and stays there, so a loop late in a long text is cut within one and
// a half tails.
// Each check reads only the tail and trims what is held to it, so the
// work is linear and the watch holds at most two tails and a delta.
export class RunawayWatch {
  private parts: string[] = [];
  private fed = 0;
  private nextCheck = STREAM_MIN_CHARS;

  // the characters fed so far
  get chars(): number {
    return this.fed;
  }

  // the text held: the latest tail and what came after it
  held(): string {
    return this.parts.join("");
  }

  // one delta; true once the channel became a runaway loop
  feed(text: string): boolean {
    if (!text) return false;
    this.parts.push(text);
    this.fed += text.length;
    if (this.fed < this.nextCheck) return false;
    this.nextCheck = this.fed + Math.min(this.fed, STREAM_TAIL_CHARS);
    const tail = this.parts.join("").slice(-STREAM_TAIL_CHARS);
    this.parts = [tail];
    return isRunawayRepetition(tail);
  }
}
