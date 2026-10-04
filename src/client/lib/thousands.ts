// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// Tokens are typed in whole thousands and the API keeps tokens. A kept
// value shows rounded and, left as shown, goes back unchanged, so 131072
// stays 131072 rather than becoming 131000.

export const K = 1000;

export const digits = (text: string): string =>
  text.trim().replaceAll(/[,_ ]/g, "");

export function thousandsText(tokens: number): string {
  return String(Math.round(tokens / K));
}

// the tokens a text stands for: the first kept value it still shows,
// else its whole thousands; null when it is not a whole number
export function thousandsValue(
  text: string,
  kept: readonly number[] = [],
): number | null {
  const v = digits(text);
  if (!/^\d+$/.test(v)) return null;
  const same = kept.find((tokens) => thousandsText(tokens) === v);
  return same ?? Number(v) * K;
}
