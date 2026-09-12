// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One line per event on stderr, prefixed by the area. Never a secret.

export type Log = (line: string) => void;

export function logger(area: string): Log {
  return (line) => console.error(`${area}: ${line}`);
}

export const silent: Log = () => {};
