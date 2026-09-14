// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the searchable select decides without a DOM: which options a
// query keeps, and where the highlight goes as the keys move it.

export type Option = {
  value: string;
  label: string;
  // the faint text after the label: an offset and a country
  detail?: string;
  // what a search also matches but the option does not show: the
  // cities of a zone
  keywords?: string;
};

// A word typed with spaces finds punctuation in a name, so "new york"
// finds America/New_York, and accents fold away, so "zurich" finds
// Zürich.
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ");

// every word of the query in the label, the detail or the keywords, in
// any order
export function filterOptions(options: Option[], query: string): Option[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((o) => {
    const text = ` ${fold(o.label)} ${fold(o.detail ?? "")} ${fold(o.keywords ?? "")}`;
    return words.every((w) => text.includes(w));
  });
}

// the picked option when a list opens, or its first row; -1 for none
export function initialHighlight(options: Option[], value: string): number {
  if (options.length === 0) return -1;
  const picked = options.findIndex((option) => option.value === value);
  return picked === -1 ? 0 : picked;
}

// an index held while the options changed, back into the shown list
export function clampHighlight(at: number, count: number): number {
  if (count === 0 || at < 0) return -1;
  return at < count ? at : 0;
}

// the highlight one step up or down, wrapping at the ends; -1 for none
export function stepHighlight(at: number, count: number, move: 1 | -1) {
  if (count === 0) return -1;
  if (at < 0) return move === 1 ? 0 : count - 1;
  return (at + move + count) % count;
}
