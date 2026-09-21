// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One line per event on stderr: the time in UTC, then the area. Never a
// secret. The time is the log's own, not the clock port's: a service
// manager's log file carries no time, and a test passes `silent`.

export type Log = (line: string) => void;

export function format(at: Date, area: string, line: string): string {
  return `${at.toISOString()} ${area}: ${line}`;
}

export function logger(area: string): Log {
  return (line) => console.error(format(new Date(), area, line));
}

export const silent: Log = () => {};
