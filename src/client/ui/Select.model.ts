// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type Option = {
  value: string;
  label: string;
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

export function filterOptions<T extends Option>(
  options: T[],
  query: string,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((o) => {
    const text = ` ${fold(o.label)} ${fold(o.detail ?? "")} ${fold(o.keywords ?? "")}`;
    return words.every((w) => text.includes(w));
  });
}

export function initialHighlight(options: Option[], value: string): number {
  if (options.length === 0) return -1;
  const picked = options.findIndex((option) => option.value === value);
  return picked === -1 ? 0 : picked;
}

// an index held while the options changed
export function clampHighlight(at: number, count: number): number {
  if (count === 0 || at < 0) return -1;
  return at < count ? at : 0;
}

export function stepHighlight(at: number, count: number, move: 1 | -1) {
  if (count === 0) return -1;
  if (at < 0) return move === 1 ? 0 : count - 1;
  return (at + move + count) % count;
}

// a list's arrows and Enter: the new highlight, a pick, or not a key
// the list takes
export function keyMove(
  key: string,
  at: number,
  count: number,
): number | "pick" | null {
  if (key === "ArrowDown") return stepHighlight(at, count, 1);
  if (key === "ArrowUp") return stepHighlight(at, count, -1);
  if (key === "Enter") return "pick";
  return null;
}
