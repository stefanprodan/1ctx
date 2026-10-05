// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// a cut text ends in an ellipsis inside the cap, so the model never
// reads a cut as the whole text; a cut never splits a surrogate pair
export function cutText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let end = cap - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}
