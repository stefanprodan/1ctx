// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The glossary's enums as const arrays and their guards. Environment
// neutral: no Bun, no DOM, no packages.

export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];
export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

// a username: the sign-in name and the handle. Lowercase, starts with
// a letter or digit, then letters, digits, dot, dash and underscore
export const MIN_USERNAME = 3;
export const MAX_USERNAME = 32;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export function isUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_USERNAME &&
    value.length <= MAX_USERNAME &&
    USERNAME_RE.test(value)
  );
}

// a full name: what a person reads. Any text, trimmed, on one line: no
// newline, carriage return, vertical tab, form feed, next line or the
// Unicode line and paragraph separators
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
export const MAX_FULL_NAME = 64;
export function isFullName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FULL_NAME &&
    value === value.trim() &&
    !LINE_BREAK.test(value)
  );
}

// what a user says about themself, for the agents: free text
export const MAX_ABOUT = 2000;
export function isAbout(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ABOUT;
}

// a password a user picks; the cap in bytes is the server's
export const MIN_PASSWORD = 8;
