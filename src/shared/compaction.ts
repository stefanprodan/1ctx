// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export function contextReserve(contextLength: number, reserve: number): number {
  return Math.min(reserve, Math.floor(contextLength / 4));
}

export function compactsAt(
  contextLength: number | null,
  reserve: number,
): number | null {
  if (contextLength === null) return null;
  const threshold = contextLength - contextReserve(contextLength, reserve);
  return threshold > 0 ? threshold : null;
}
