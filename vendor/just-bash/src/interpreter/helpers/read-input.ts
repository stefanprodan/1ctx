/**
 * (1ctx read-utf8) Input helpers for read and mapfile.
 *
 * Their stdin is a latin1-shaped byte buffer (one char per byte), while
 * variables hold Unicode text. These helpers scan the bytes as bash does
 * in a UTF-8 locale and decode what lands in a variable.
 */

const utf8Encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

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
 * How many bytes the character at `pos` takes: a whole well-formed UTF-8
 * sequence (no overlong form, surrogate or code point past U+10FFFF), or
 * one byte when the bytes there are not one.
 */
export function utf8CharBytes(bytes: string, pos: number): number {
  const lead = bytes.charCodeAt(pos);
  if (lead < 0xc2 || lead > 0xf4) return 1;
  const length = lead <= 0xdf ? 2 : lead <= 0xef ? 3 : 4;
  if (pos + length > bytes.length) return 1;
  // The second byte's range depends on the lead (RFC 3629 section 4).
  const second = bytes.charCodeAt(pos + 1);
  const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
  const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
  if (second < low || second > high) return 1;
  for (let k = 2; k < length; k++) {
    const next = bytes.charCodeAt(pos + k);
    if (next < 0x80 || next > 0xbf) return 1;
  }
  return length;
}

/**
 * Decode collected bytes as UTF-8 text, one well-formed sequence at a
 * time: a byte that starts none stays one character, U+0080 to U+00FF,
 * so the valid characters around it still decode.
 */
export function decodeInput(bytes: string): string {
  let high = false;
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    if (code > 0xff) return bytes;
    if (code > 0x7f) high = true;
  }
  if (!high) return bytes;
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  try {
    return strictDecoder.decode(buffer);
  } catch {
    // Not valid as a whole: decode around the bytes that are not.
  }
  let out = "";
  let pos = 0;
  while (pos < bytes.length) {
    const length = utf8CharBytes(bytes, pos);
    out +=
      length === 1
        ? bytes[pos]
        : strictDecoder.decode(buffer.subarray(pos, pos + length));
    pos += length;
  }
  return out;
}
