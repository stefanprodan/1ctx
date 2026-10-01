/**
 * (1ctx) Input helpers for read and mapfile.
 *
 * Their stdin is a latin1-shaped byte buffer (one char per byte), while
 * variables hold Unicode text. These helpers scan the bytes as bash does
 * in a UTF-8 locale and decode what lands in a variable.
 */

import { decodeBytesToUtf8, unsafeBytesFromLatin1 } from "../../encoding.js";

const utf8Encoder = new TextEncoder();

/**
 * The delimiter byte for `-d delim`: bash takes the first byte of the
 * argument, so a multibyte character delimits on its lead byte.
 */
export function delimiterByte(arg: string): string {
  if (arg === "") return "\0";
  const code = arg.charCodeAt(0);
  if (code < 0x80) return arg[0];
  return String.fromCharCode(utf8Encoder.encode(arg)[0]);
}

/**
 * How many bytes the character at `pos` takes: a whole UTF-8 sequence,
 * or one byte when the bytes there are not one.
 */
export function utf8CharBytes(bytes: string, pos: number): number {
  const lead = bytes.charCodeAt(pos);
  let length = 1;
  if (lead >= 0xc2 && lead <= 0xdf) length = 2;
  else if (lead >= 0xe0 && lead <= 0xef) length = 3;
  else if (lead >= 0xf0 && lead <= 0xf4) length = 4;
  if (length === 1 || pos + length > bytes.length) return 1;
  for (let k = 1; k < length; k++) {
    const next = bytes.charCodeAt(pos + k);
    if (next < 0x80 || next > 0xbf) return 1;
  }
  return length;
}

/**
 * Decode collected bytes as UTF-8 text; bytes that are not valid UTF-8
 * stay one character each, as the shell held them before.
 */
export function decodeInput(bytes: string): string {
  return decodeBytesToUtf8(unsafeBytesFromLatin1(bytes));
}
