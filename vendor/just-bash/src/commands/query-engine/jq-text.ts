/**
 * Values written and ordered as jq does, kept out of the engine's core
 * files so an upstream sync meets few hunks (1ctx jq-compare jq-infinity
 * jq-iterate-null)
 */

/**
 * A value as jq writes it: an infinity as the largest double, where
 * JSON.stringify writes null (1ctx jq-infinity)
 */
export function jqJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      typeof v === "number" && v === Number.POSITIVE_INFINITY
        ? Number.MAX_VALUE
        : typeof v === "number" && v === Number.NEGATIVE_INFINITY
          ? -Number.MAX_VALUE
          : v,
    ) ?? "null"
  );
}

/**
 * Two strings in code point order, the order of their UTF-8 bytes, as jq
 * and Go compare them; upstream used the locale's (1ctx jq-compare)
 */
export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // a surrogate starts a code point above every unit from U+E000
    const rank = (unit: number) =>
      unit < 0xd800 ? unit : unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
    return rank(x) - rank(y);
  }
  return a.length - b.length;
}

/** Keys sorted as jq sorts them, by code point (1ctx jq-compare) */
export function sortedKeys(keys: string[]): string[] {
  return keys.sort(compareText);
}

/** A value as jq's errors name it, cut to 30 bytes (1ctx jq-iterate-null) */
export function iterated(v: unknown): string {
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const text = JSON.stringify(v) ?? "null";
  return `${kind} (${text.length > 29 ? `${text.slice(0, 26)}...` : text})`;
}
