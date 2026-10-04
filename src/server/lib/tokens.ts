// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts for what a page shows, and cuts to fit a window, through
// OpenAI's o200k_base encoding. It is exact for OpenAI models and close for the open ones
// on English and code; other vendors count their own way, so a count is
// shown as an estimate. Only the one encoding is imported, since each
// carries its whole vocabulary into the binary. The merge step is
// quadratic in the length of one word: a knowledge file of one unbroken
// 256 KiB word took twenty seconds whole and milliseconds in pieces, and
// a run of whitespace is one word too (80 KB of tabs and line breaks
// took a second and a half), so a text holding either past the piece
// size is counted in pieces cut at a line break where one is near; a
// count off by a token per piece is within the estimate, and every
// other text is counted whole, exactly.

import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

// a special token's text (<|im_start|>, <|endoftext|>) in a chat or a
// file is counted as plain text: the library throws on it by default
const AS_TEXT = { disallowedSpecial: new Set<string>() };

export const TOKEN_PIECE = 4096;
const LONG_WORD = new RegExp(`\\S{${TOKEN_PIECE + 1}}|\\s{${TOKEN_PIECE + 1}}`);

export function tokens(text: string): number {
  if (text === "") return 0;
  if (text.length <= TOKEN_PIECE || !LONG_WORD.test(text)) {
    return countTokens(text, AS_TEXT);
  }
  let total = 0;
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + TOKEN_PIECE);
    if (end < text.length) {
      const line = text.lastIndexOf("\n", end);
      if (line > at) end = line + 1;
    }
    total += countTokens(text.slice(at, end), AS_TEXT);
    at = end;
  }
  return total;
}

// o200k averages four characters a token on English and code; a start
// this long holds more than max tokens of any text but a rare one
export const CHARS_PER_TOKEN = 12;

// the start of text within max tokens: the characters are cut first,
// so a huge text is never counted whole, then trimmed to the count
export function cutToTokens(text: string, max: number): string {
  if (max <= 0) return "";
  let cut = text.slice(0, max * CHARS_PER_TOKEN);
  for (let count = tokens(cut); count > max; count = tokens(cut)) {
    cut = cut.slice(0, Math.floor((cut.length * max) / count));
  }
  // a cut between the halves of a surrogate pair drops the lone half
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
