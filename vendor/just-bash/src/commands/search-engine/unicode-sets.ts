/**
 * (1ctx) Unicode classes spelled for RE2, shared by grep -P's layer and
 * rg's default syntax: horizontal and vertical space, the general
 * categories as code point ranges, and the sets built from them.
 */

export const H =
  "\\t \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}";
export const V = "\\n\\x0b\\f\\r\\x{85}\\x{2028}\\x{2029}";

const categories = new Map<string, string>();

/**
 * A general category as code point ranges. RE2JS folds case with tables
 * that lack the caseless categories and throws on \p{N} under -i, so every
 * category but the letters and marks is spelled out, once per process.
 */
export function category(name: string): string {
  if (/^[LM]/.test(name)) return `\\p{${name}}`;
  let ranges = categories.get(name);
  if (ranges !== undefined) return ranges;
  const re = new RegExp(`^\\p{${name}}$`, "u");
  const hex = (cp: number) => `\\x{${cp.toString(16)}}`;
  ranges = "";
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const inside = cp < 0x110000 && re.test(String.fromCodePoint(cp));
    if (inside && start < 0) start = cp;
    if (!inside && start >= 0) {
      ranges += start === cp - 1 ? hex(start) : `${hex(start)}-${hex(cp - 1)}`;
      start = -1;
    }
  }
  categories.set(name, ranges);
  return ranges;
}

/** JavaScript's names for the general categories, which RE2 shares. */
export const GENERAL = /^(?:[LMNPSZC][a-z]?)$/;

let space: string | undefined;

/** \s: horizontal and vertical space and the separators. */
export function spaceSet(): string {
  space ??= `${H}${V}${category("Z")}`;
  return space;
}
