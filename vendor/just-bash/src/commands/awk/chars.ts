/**
 * (1ctx) Characters as gawk counts them in a UTF-8 locale: code points,
 * where JavaScript strings count UTF-16 units. Text without an astral
 * character takes the fast path, where the two agree.
 */

const SURROGATE = /[\uD800-\uDFFF]/;

/** The number of characters in text. */
export function charLength(text: string): number {
  if (!SURROGATE.test(text)) return text.length;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    count++;
    if (isPair(text, i)) i++;
  }
  return count;
}

/** The UTF-16 offset of the character at index `chars`, clamped to the end. */
export function unitOffset(text: string, chars: number): number {
  if (chars <= 0) return 0;
  if (!SURROGATE.test(text)) return Math.min(chars, text.length);
  let i = 0;
  for (let n = 0; n < chars && i < text.length; n++) {
    i += isPair(text, i) ? 2 : 1;
  }
  return i;
}

/** The characters from index `start` up to, not including, `end`. */
export function charSlice(text: string, start: number, end?: number): string {
  const from = unitOffset(text, start);
  return end === undefined
    ? text.slice(from)
    : text.slice(from, unitOffset(text, end));
}

/** The number of characters before a UTF-16 offset. */
export function charsBefore(text: string, offset: number): number {
  return charLength(text.slice(0, offset));
}

/** The first character of text, or "". */
export function firstChar(text: string): string {
  if (text === "") return "";
  return String.fromCodePoint(text.codePointAt(0) ?? 0);
}

/** Each character of text. */
export function chars(text: string): string[] {
  return SURROGATE.test(text) ? Array.from(text) : text.split("");
}

function isPair(text: string, i: number): boolean {
  const hi = text.charCodeAt(i);
  if (hi < 0xd800 || hi > 0xdbff) return false;
  const lo = text.charCodeAt(i + 1);
  return lo >= 0xdc00 && lo <= 0xdfff;
}
