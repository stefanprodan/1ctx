// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// A reviewer and the model get the same visible text. Tabs and newlines
// stay useful; controls, tags and selected format characters do not.
export function cleanText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f);
    const format =
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2060 && code <= 0x2064);
    const tag = code >= 0xe0000 && code <= 0xe007f;
    if (!control && !format && !tag) out += char;
  }
  return out;
}
