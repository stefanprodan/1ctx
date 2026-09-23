/**
 * (1ctx) AWK number and printf formatting, as gawk in a UTF-8 locale.
 *
 * Numbers are formatted from their exact binary value, rounding half to
 * even as C's printf does (JavaScript's toFixed rounds exact ties up), and
 * a whole number prints as its exact integer whatever its size. Widths and
 * precisions count characters (code points), not UTF-16 units.
 */

import { utf8ByteLength } from "../../encoding.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import { charLength, charSlice, firstChar } from "./chars.js";
import type { AwkValue } from "./interpreter/types.js";

export const DEFAULT_AWK_STRING_LIMIT = 10 * 1024 * 1024;
const MAX_PRINTF_WIDTH = 10000;
const MAX_FLOAT_PRECISION = 100;

/** awk's string value of a number: an integer exactly, else through fmt. */
export function numberToString(n: number, fmt: string): string {
  if (Number.isInteger(n)) return integerString(n);
  if (!Number.isFinite(n)) return special(n);
  // a CONVFMT of "%s" would come back here; gawk's default stands in
  return formatPrintf(fmt, [n], DEFAULT_AWK_STRING_LIMIT, "%.6g");
}

/** A whole number's exact decimal digits; -0 is "0". */
export function integerString(n: number): string {
  if (Number.isSafeInteger(n)) return String(n === 0 ? 0 : n);
  return BigInt(n).toString();
}

function special(n: number): string {
  if (Number.isNaN(n)) return "+nan";
  return n > 0 ? "+inf" : "-inf";
}

/** awk's numeric value of a string: its longest numeric prefix, else 0. */
function toNumber(val: AwkValue | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === "number") return val;
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

// ─── Exact decimal digits ────────────────────────────────────────

/**
 * The exact value of a positive finite double as decimal digits (no
 * leading zeros) and the position of the decimal point from their start.
 */
function exactDigits(x: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (biased === 0) {
    exp = -1074;
  } else {
    mantissa |= 1n << 52n;
    exp = biased - 1075;
  }
  if (exp >= 0) {
    const digits = (mantissa << BigInt(exp)).toString();
    return { digits, point: digits.length };
  }
  const digits = (mantissa * 5n ** BigInt(-exp)).toString();
  return { digits, point: digits.length + exp };
}

/**
 * Keeps `keep` leading digits, rounding half to even on the exact value.
 * Returns the kept digits (padded with zeros to `keep`) and the point.
 */
function roundDigits(
  digits: string,
  point: number,
  keep: number,
): { digits: string; point: number } {
  if (keep < 0) return { digits: "", point };
  if (digits.length <= keep) {
    return { digits: digits.padEnd(keep, "0"), point };
  }
  const head = digits.slice(0, keep);
  const next = digits.charCodeAt(keep) - 48;
  const rest = digits.slice(keep + 1);
  const odd = keep > 0 && (digits.charCodeAt(keep - 1) - 48) % 2 === 1;
  const up = next > 5 || (next === 5 && (/[1-9]/.test(rest) || odd));
  if (!up) return { digits: head, point };
  if (keep === 0) return { digits: "1", point: point + 1 };
  const bumped = (BigInt(head) + 1n).toString().padStart(keep, "0");
  if (bumped.length > keep) {
    return { digits: bumped.slice(0, keep), point: point + 1 };
  }
  return { digits: bumped, point };
}

/** %f of a non-negative finite number. */
function fixed(x: number, prec: number): string {
  if (x === 0) return prec > 0 ? `0.${"0".repeat(prec)}` : "0";
  const exact = exactDigits(x);
  const keep = exact.point + prec;
  let { digits, point } = roundDigits(exact.digits, exact.point, keep);
  if (keep < 0) {
    digits = "";
  }
  // digits now hold the value to `prec` places, the point `point` in
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  }
  digits = digits.padEnd(point + prec, "0");
  const int = digits.slice(0, point) || "0";
  const frac = digits.slice(point, point + prec);
  return prec > 0 ? `${int}.${frac}` : int;
}

/** Mantissa digits and decimal exponent of x to `sig` significant digits. */
function significant(x: number, sig: number): { digits: string; exp: number } {
  if (x === 0) return { digits: "0".repeat(sig), exp: 0 };
  const exact = exactDigits(x);
  const { digits, point } = roundDigits(exact.digits, exact.point, sig);
  return { digits, exp: point - 1 };
}

function exponent(exp: number): string {
  const sign = exp < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** %e of a non-negative finite number. */
function scientific(x: number, prec: number, alt: boolean): string {
  const { digits, exp } = significant(x, prec + 1);
  const frac = digits.slice(1);
  const point = prec > 0 || alt ? "." : "";
  return `${digits[0]}${point}${frac}e${exponent(exp)}`;
}

/** %g of a non-negative finite number. */
function general(x: number, prec: number, alt: boolean): string {
  const p = prec === 0 ? 1 : prec;
  const { exp } = significant(x, p);
  let out: string;
  if (exp < -4 || exp >= p) {
    out = scientific(x, p - 1, alt);
    if (!alt) out = out.replace(/\.?0+e/, "e");
  } else {
    out = fixed(x, p - 1 - exp);
    if (alt && !out.includes(".")) out += ".";
    if (!alt && out.includes(".")) out = out.replace(/\.?0+$/, "");
  }
  return out;
}

// ─── printf ──────────────────────────────────────────────────────

interface Spec {
  flags: string;
  width: number | undefined;
  precision: number | undefined;
}

function pad(text: string, spec: Spec, zeroFrom = -1): string {
  const width = spec.width ?? 0;
  const length = charLength(text);
  if (length >= width) return text;
  if (spec.flags.includes("-")) return text + " ".repeat(width - length);
  if (zeroFrom >= 0 && spec.flags.includes("0")) {
    return (
      text.slice(0, zeroFrom) +
      "0".repeat(width - length) +
      text.slice(zeroFrom)
    );
  }
  return " ".repeat(width - length) + text;
}

function signOf(negative: boolean, flags: string): string {
  if (negative) return "-";
  if (flags.includes("+")) return "+";
  if (flags.includes(" ")) return " ";
  return "";
}

function formatInteger(n: number, spec: Spec, conv: string): string {
  if (!Number.isFinite(n)) return pad(special(n), spec);
  const t = Math.trunc(n);
  const negative = t < 0;
  const magnitude = negative ? -t : t;
  const big = Number.isSafeInteger(magnitude)
    ? null
    : BigInt(magnitude);
  let digits: string;
  let prefix = "";
  if (conv === "x" || conv === "X") {
    digits = (big ?? magnitude).toString(16);
    if (conv === "X") digits = digits.toUpperCase();
    if (spec.flags.includes("#") && magnitude !== 0) {
      prefix = conv === "X" ? "0X" : "0x";
    }
  } else if (conv === "o") {
    digits = (big ?? magnitude).toString(8);
    if (spec.flags.includes("#") && !digits.startsWith("0")) prefix = "0";
  } else {
    digits = (big ?? magnitude).toString();
  }
  if (spec.precision !== undefined) {
    digits =
      spec.precision === 0 && magnitude === 0
        ? ""
        : digits.padStart(spec.precision, "0");
  }
  const lead = signOf(negative, spec.flags) + prefix;
  const zero = spec.precision === undefined ? lead.length : -1;
  return pad(lead + digits, spec, zero);
}

function formatFloat(n: number, spec: Spec, conv: string): string {
  if (!Number.isFinite(n)) {
    const text = special(n);
    return pad(conv === conv.toUpperCase() ? text.toUpperCase() : text, spec);
  }
  const prec = spec.precision ?? 6;
  if (prec > MAX_FLOAT_PRECISION) {
    throw new ExecutionLimitError(
      "printf floating-point precision limit exceeded (100 digits)",
      "string_length",
    );
  }
  const negative = n < 0 || Object.is(n, -0);
  const x = Math.abs(n);
  const alt = spec.flags.includes("#");
  let body: string;
  if (conv === "f" || conv === "F") {
    body = fixed(x, prec);
    if (alt && prec === 0) body += ".";
  } else if (conv === "e" || conv === "E") {
    body = scientific(x, prec, alt);
  } else {
    body = general(x, prec, alt);
  }
  if (conv === "E" || conv === "G") body = body.toUpperCase();
  const sign = signOf(negative, spec.flags);
  return pad(sign + body, spec, sign.length);
}

function formatString(text: string, spec: Spec): string {
  const cut =
    spec.precision !== undefined ? charSlice(text, 0, spec.precision) : text;
  return pad(cut, spec);
}

function formatChar(val: AwkValue | undefined, spec: Spec): string {
  if (typeof val === "number") {
    const code = Math.trunc(val);
    const valid =
      code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return pad(valid ? String.fromCodePoint(code) : "", spec);
  }
  return pad(firstChar(val ?? ""), spec);
}

/**
 * awk's printf and sprintf. `convfmt` turns a number given to %s into
 * its string value, as CONVFMT does.
 */
export function formatPrintf(
  format: string,
  values: AwkValue[],
  maxBytes: number = DEFAULT_AWK_STRING_LIMIT,
  convfmt = "%.6g",
): string {
  let valueIdx = 0;
  let result = "";
  let resultBytes = 0;
  let i = 0;
  const maxFieldWidth = Math.min(MAX_PRINTF_WIDTH, maxBytes);
  const append = (value: string): void => {
    const bytes = utf8ByteLength(value);
    if (bytes > maxBytes - resultBytes) {
      throw new ExecutionLimitError(
        `formatted string size limit exceeded (${maxBytes} bytes)`,
        "string_length",
      );
    }
    result += value;
    resultBytes += bytes;
  };
  const tooWide = (what: string): ExecutionLimitError =>
    new ExecutionLimitError(
      `printf ${what} limit exceeded (${maxFieldWidth} bytes)`,
      "string_length",
    );

  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      let j = i + 1;
      let positionalIdx: number | undefined;

      // Positional argument: %n$
      const posStart = j;
      while (j < format.length && /\d/.test(format[j])) j++;
      if (j > posStart && format[j] === "$") {
        positionalIdx = parseInt(format.substring(posStart, j), 10) - 1;
        j++;
      } else {
        j = posStart;
      }

      let flags = "";
      while (j < format.length && /[-+ #0]/.test(format[j])) {
        flags += format[j++];
      }

      // (1ctx) gawk's fatal error for a conversion with no argument left
      const take = (index: number): AwkValue => {
        if (index >= values.length) {
          throw new Error("not enough arguments to satisfy format string");
        }
        return values[index];
      };

      let width: number | undefined;
      if (format[j] === "*") {
        const w = Math.trunc(toNumber(take(valueIdx++)));
        if (!Number.isSafeInteger(w)) throw tooWide("width");
        if (w < 0) flags += "-";
        width = Math.abs(w);
        j++;
      } else {
        let digits = "";
        while (j < format.length && /\d/.test(format[j])) digits += format[j++];
        if (digits) width = parseInt(digits, 10);
      }
      if (width !== undefined && width > maxFieldWidth) throw tooWide("width");

      let precision: number | undefined;
      if (format[j] === ".") {
        j++;
        if (format[j] === "*") {
          const p = Math.trunc(toNumber(take(valueIdx++)));
          if (!Number.isSafeInteger(p)) throw tooWide("precision");
          precision = p < 0 ? undefined : p;
          j++;
        } else {
          let digits = "";
          while (j < format.length && /\d/.test(format[j])) {
            digits += format[j++];
          }
          precision = digits ? parseInt(digits, 10) : 0;
        }
        if (precision !== undefined && precision > maxFieldWidth) {
          throw tooWide("precision");
        }
      }

      // Length modifiers (h, hh, l, ll, j, z) mean nothing in awk
      if (/^(hh|ll)/.test(format.slice(j, j + 2))) j += 2;
      else if (/[lzjhL]/.test(format[j] ?? "")) j++;

      const spec: Spec = { flags, width, precision };
      const conv = format[j];
      const valIdx = positionalIdx ?? valueIdx;
      let consumed = true;

      switch (conv) {
        case "s": {
          const val = take(valIdx);
          append(
            formatString(
              typeof val === "number" ? numberToString(val, convfmt) : val,
              spec,
            ),
          );
          break;
        }
        case "d":
        case "i":
        case "u":
        case "x":
        case "X":
        case "o":
          append(formatInteger(toNumber(take(valIdx)), spec, conv));
          break;
        case "f":
        case "F":
        case "e":
        case "E":
        case "g":
        case "G":
          append(formatFloat(toNumber(take(valIdx)), spec, conv));
          break;
        case "c":
          append(formatChar(take(valIdx), spec));
          break;
        case "%":
          append("%");
          consumed = false;
          break;
        default:
          append(format.substring(i, j + 1));
          consumed = false;
      }
      if (consumed && positionalIdx === undefined) valueIdx++;
      i = j + 1;
    } else if (format[i] === "\\" && i + 1 < format.length) {
      const esc = format[i + 1];
      switch (esc) {
        case "n":
          append("\n");
          break;
        case "t":
          append("\t");
          break;
        case "r":
          append("\r");
          break;
        case "\\":
          append("\\");
          break;
        default:
          append(esc);
      }
      i += 2;
    } else {
      append(format[i++]);
    }
  }

  return result;
}
