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

// a project is personal (one per user, made with the user) or team
export const PROJECT_KINDS = ["personal", "team"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export function isProjectKind(value: unknown): value is ProjectKind {
  return (
    typeof value === "string" &&
    (PROJECT_KINDS as readonly string[]).includes(value)
  );
}

// a name an admin gives a thing on the server: a provider, an agent,
// an automation. Lowercase letters, digits and dashes, short enough for
// a rail row
export const MIN_NAME = 2;
export const MAX_NAME = 32;
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_NAME &&
    value.length <= MAX_NAME &&
    NAME_RE.test(value)
  );
}

// the wire a provider speaks: OpenRouter, with its catalog, prices and
// reasoning object, or any server speaking the OpenAI chat completions
// shape, which is not OpenAI itself
// the robots an agent shows as; adding one is a code change
export const AVATARS = ["bot", "face", "dome", "boxy", "bust"] as const;
export type Avatar = (typeof AVATARS)[number];
export function isAvatar(value: unknown): value is Avatar {
  return (
    typeof value === "string" && (AVATARS as readonly string[]).includes(value)
  );
}

export const WIRES = ["openrouter", "openai-compatible"] as const;
export type Wire = (typeof WIRES)[number];
export function isWire(value: unknown): value is Wire {
  return (
    typeof value === "string" && (WIRES as readonly string[]).includes(value)
  );
}

// a session's, and a send's, status: running while a send holds the
// lock, then how the last send ended
export const SESSION_STATUSES = [
  "running",
  "done",
  "failed",
  "stopped",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// why a send ended: the model finished, a user stopped it, the
// provider failed, the process shut down, or the process was found
// restarted with the send still running
export const SEND_CAUSES = [
  "finish",
  "stop",
  "failure",
  "shutdown",
  "restart",
] as const;
export type SendCause = (typeof SEND_CAUSES)[number];

export const MESSAGE_KINDS = ["user", "reply", "tool"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_STATUSES = [
  "streaming",
  "done",
  "failed",
  "stopped",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// a message a user writes; the cap is in bytes, the server's
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_TITLE = 80;
// the stream's search box
export const MAX_SEARCH = 100;

// the built-in tools, each with a server-wide switch on the tools page
export const BUILTIN_TOOLS = [
  "get_current_time",
  "webfetch",
  "websearch",
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export function isBuiltinTool(value: unknown): value is BuiltinTool {
  return BUILTIN_TOOLS.includes(value as BuiltinTool);
}

// the services websearch can run on; the key file carries the name
export const SEARCH_PROVIDERS = ["exa", "firecrawl"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export function isSearchProvider(value: unknown): value is SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider);
}

// the limits an admin may override: the loop caps of a send, then the
// caps a single tool call runs under. The names are the keys the
// runner and the tools read, so a row maps to a cap without a table.
export const LIMIT_NAMES = [
  "rounds",
  "callsPerRound",
  "callsPerSend",
  "toolMs",
  "resultBytes",
  "callTimeoutMs",
  "resultCut",
  "maxFetches",
  "maxSearches",
  "fetchBodyBytes",
  "searchBodyBytes",
  "fetchDeadlineMs",
  "searchDeadlineMs",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
export function isLimitName(value: unknown): value is LimitName {
  return LIMIT_NAMES.includes(value as LimitName);
}

// what a limit's number counts; the page turns ms and bytes into words
export const LIMIT_UNITS = ["count", "ms", "bytes", "chars"] as const;
export type LimitUnit = (typeof LIMIT_UNITS)[number];

// where a limit applies: over the whole send, or to one tool call
export const LIMIT_SCOPES = ["send", "call"] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];
