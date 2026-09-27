// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a name field does as it is typed. The rule itself is the
// server's, in words.ts.

// what a name field does as it is typed, so the box holds only what can
// be saved: lowercase, accents stripped, a space or a dot a dash, every
// other character outside the rule dropped, and no leading dash or
// underscore. The length and a clash stay for the server to refuse
export function shapeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ .]/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
}

// what a server name field does as it is typed: shapeName, and an
// underscore becomes a dash
export function shapeServerName(value: string): string {
  return shapeName(value).replace(/_/g, "-");
}
