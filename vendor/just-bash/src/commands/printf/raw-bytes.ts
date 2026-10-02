/**
 * (1ctx printf-bytes) A byte escape above 0x7f (`\351`, `\xe9`) names a byte,
 * not a character: bash writes the byte. printf and echo hold such a byte
 * as a lone low surrogate, U+DC80 plus the byte less 0x80, which no text
 * decoded from UTF-8 contains, and turn it into the byte itself on output.
 */

import { encodeUtf8ToBytes, latin1FromBytes } from "../../encoding.js";

const FIRST = 0xdc80;
const LAST = 0xdcff;

/** A byte as printf and echo hold it until output. */
export function escapedByte(byte: number): string {
  return byte < 0x80
    ? String.fromCharCode(byte)
    : String.fromCharCode(FIRST + byte - 0x80);
}

// a held byte: a lone low surrogate in range, not the second half of a pair
function heldAt(text: string, index: number): number | undefined {
  const code = text.charCodeAt(index);
  if (code < FIRST || code > LAST) return undefined;
  const before = index > 0 ? text.charCodeAt(index - 1) : 0;
  if (before >= 0xd800 && before <= 0xdbff) return undefined;
  return code - FIRST + 0x80;
}

function holdsBytes(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (heldAt(text, index) !== undefined) return true;
  }
  return false;
}

/**
 * Output as a command returns it: text as it is, or, when it holds bytes,
 * a byte buffer of its text in UTF-8 with each held byte as itself.
 */
export function outputOf(text: string): {
  stdout: string;
  stdoutKind?: "bytes";
} {
  if (!holdsBytes(text)) return { stdout: text };
  let bytes = "";
  let run = 0;
  const flush = (end: number) => {
    if (end > run) {
      bytes += latin1FromBytes(encodeUtf8ToBytes(text.slice(run, end)));
    }
  };
  for (let index = 0; index < text.length; index++) {
    const byte = heldAt(text, index);
    if (byte === undefined) continue;
    flush(index);
    bytes += String.fromCharCode(byte);
    run = index + 1;
  }
  flush(text.length);
  return { stdout: bytes, stdoutKind: "bytes" };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// the length of the UTF-8 sequence a lead byte opens, 0 for no lead
function sequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/**
 * Text as a variable keeps it: held bytes that spell a UTF-8 character
 * (`\xc3\xa9`) become that character, as bash keeps the bytes and they
 * read back as it; a lone byte becomes the character of its value.
 */
export function textOf(text: string): string {
  if (!holdsBytes(text)) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const byte = heldAt(text, index);
    if (byte === undefined) {
      result += text[index];
      index++;
      continue;
    }
    const length = sequenceLength(byte);
    const bytes = [byte];
    for (let next = 1; next < length; next++) {
      const more = heldAt(text, index + next);
      if (more === undefined) break;
      bytes.push(more);
    }
    let decoded: string | undefined;
    if (length > 0 && bytes.length === length) {
      try {
        decoded = strictUtf8.decode(Uint8Array.from(bytes));
      } catch {
        // an overlong form or a surrogate: each byte stays alone
      }
    }
    if (decoded === undefined) {
      result += String.fromCharCode(byte);
      index++;
    } else {
      result += decoded;
      index += length;
    }
  }
  return result;
}
