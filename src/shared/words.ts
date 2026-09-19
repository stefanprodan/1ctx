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

// a name on the server, the way Slack names a channel: lowercase letters,
// digits, dashes and underscores, starting with a letter or a digit.
// ASCII only, so lowercasing needs no locale and no lookalike slips past
// a uniqueness check. Projects, agents and providers take it as it is;
// a username takes it with its own length
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const NAME_CHARACTERS =
  "lowercase letters, digits, dashes and underscores";

// what a name field does as it is typed: lowercase, and a space or a dot
// becomes a dash. Anything else stays for the server to refuse
export function shapeName(value: string): string {
  return value.toLowerCase().replace(/[ .]/g, "-");
}

// a username: the sign-in name and the handle
export const MIN_USERNAME = 3;
export const MAX_USERNAME = 32;
export function isUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_USERNAME &&
    value.length <= MAX_USERNAME &&
    NAME_RE.test(value)
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

export const MAX_EMAIL = 254;
const WHITESPACE = /\s/;
export function isEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > MAX_EMAIL ||
    value !== value.trim() ||
    LINE_BREAK.test(value) ||
    WHITESPACE.test(value)
  ) {
    return false;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => label.length > 0) &&
    labels[labels.length - 1].length >= 2
  );
}

// what a team project is for: one trimmed line, empty for none
export const MAX_DESCRIPTION = 280;
export function isDescription(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_DESCRIPTION &&
    value === value.trim() &&
    !LINE_BREAK.test(value)
  );
}

// what a user says about themself, for the agents: free text
export const MAX_ABOUT = 2000;
export function isAbout(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ABOUT;
}

// a password a user picks
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD_BYTES = 1024;

// a project is personal (one per user, made with the user) or team
export const PROJECT_KINDS = ["personal", "team"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export function isProjectKind(value: unknown): value is ProjectKind {
  return (
    typeof value === "string" &&
    (PROJECT_KINDS as readonly string[]).includes(value)
  );
}

// a name an admin gives a thing on the server: a project, a provider, an
// agent
export const MIN_NAME = 2;
export const MAX_NAME = 80;
export function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_NAME &&
    value.length <= MAX_NAME &&
    NAME_RE.test(value)
  );
}

// a knowledge file's name is a path: one to eight segments joined by
// `/`, each 1 to 80 characters of ASCII letters, digits, dot, dash and
// underscore, never `.` or `..`, 200 characters at most
export const MAX_KNOWLEDGE_NAME = 200;
export const MAX_KNOWLEDGE_SEGMENTS = 8;
const KNOWLEDGE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,80}$/;
export function isKnowledgeName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > MAX_KNOWLEDGE_NAME) return false;
  const parts = value.split("/");
  if (parts.length > MAX_KNOWLEDGE_SEGMENTS) return false;
  return parts.every(
    (part) => part !== "." && part !== ".." && KNOWLEDGE_SEGMENT_RE.test(part),
  );
}

// an MCP server's name: the channel rule without the underscore, 2 to
// 24. It makes the wire name mcp__<server>__<tool>, so with no `_` in
// it the first `__` after `mcp__` always ends it, and at 24 the longest
// name leaves 33 characters for the tool inside the wire's 64
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MIN_SERVER_NAME = 2;
export const MAX_SERVER_NAME = 24;
export function isServerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_SERVER_NAME &&
    value.length <= MAX_SERVER_NAME &&
    SERVER_NAME_RE.test(value)
  );
}
// what a server name field does as it is typed: shapeName, and an
// underscore becomes a dash
export function shapeServerName(value: string): string {
  return shapeName(value).replace(/_/g, "-");
}

// the two sides an MCP server's tools are sorted into
export const SIDES = ["read", "write"] as const;
export type Side = (typeof SIDES)[number];
export function isSide(value: unknown): value is Side {
  return SIDES.includes(value as Side);
}

// a pattern on MCP tool names: `*` alone, or a name in the characters
// MCP allows with an optional trailing `*` making it a prefix
const PATTERN_RE = /^[a-zA-Z0-9_.-]{1,128}\*?$/;
export function isPattern(value: unknown): value is string {
  return typeof value === "string" && (value === "*" || PATTERN_RE.test(value));
}
export const MAX_PATTERNS = 50;

// how an agent's MCP tools reach the model: every schema on the wire,
// a catalog with two tools, or whichever the token cap picks
export const MCP_MODES = ["all", "catalog", "auto"] as const;
export type McpMode = (typeof MCP_MODES)[number];
export function isMcpMode(value: unknown): value is McpMode {
  return MCP_MODES.includes(value as McpMode);
}

// a secret file is named <kind>-<name>.key, so the directory says what
// it holds and a form offers the files of its own kind and no others
export const SECRET_KINDS = ["user-", "provider-", "search-", "mcp-"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const MCP_KEY_PREFIX = "mcp-" satisfies SecretKind;

export function isSecretName(kind: string, value: unknown): value is string {
  return (
    SECRET_KINDS.some((known) => known === kind) &&
    typeof value === "string" &&
    value === value.trim() &&
    value.startsWith(kind) &&
    /^[a-z0-9][a-z0-9-]{0,47}$/.test(value.slice(kind.length))
  );
}

// an MCP server's own call timeout, null for the limits' callTimeoutMs
export const MCP_TIMEOUT_MS = { min: 1_000, max: 3_600_000 } as const;
export const MAX_MCP_URL = 2048;

// every personal project is named this, so a team project may not be
export const PERSONAL_PROJECT_NAME = "personal";
export const RESERVED_PROJECT_NAMES: readonly string[] = [
  PERSONAL_PROJECT_NAME,
];

// the robots an agent shows as; adding one is a code change
export const AVATARS = ["bot", "face", "dome", "boxy", "bust"] as const;
export type Avatar = (typeof AVATARS)[number];
export function isAvatar(value: unknown): value is Avatar {
  return (
    typeof value === "string" && (AVATARS as readonly string[]).includes(value)
  );
}

// the wire a provider speaks: OpenRouter, an OpenAI-compatible server,
// a server that refuses any field outside the OpenAI spec, or Google AI
// Studio with its native catalog and compatible chat endpoint
export const WIRES = [
  "openrouter",
  "openai-compatible",
  "openai-strict",
  "gemini",
] as const;
export type Wire = (typeof WIRES)[number];
export function isWire(value: unknown): value is Wire {
  return (
    typeof value === "string" && (WIRES as readonly string[]).includes(value)
  );
}

export const EFFORTS = {
  openrouter: ["minimal", "low", "medium", "high", "xhigh"],
  "openai-compatible": ["low", "medium", "high"],
  // Groq refuses minimal, on every model tried
  "openai-strict": ["low", "medium", "high"],
  gemini: ["low", "medium", "high"],
} as const satisfies Record<Wire, readonly string[]>;
export type Effort = (typeof EFFORTS)[Wire][number];
export function isEffort(wire: Wire, value: unknown): value is Effort {
  return EFFORTS[wire].includes(value as never);
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
// provider failed, the process shut down, the process was found
// restarted with the send still running, or a run passed its deadline
export const SEND_CAUSES = [
  "finish",
  "stop",
  "failure",
  "shutdown",
  "restart",
  "deadline",
] as const;
export type SendCause = (typeof SEND_CAUSES)[number];

// a run is the send an automation opens its session with
export const SEND_KINDS = ["chat", "compact", "run"] as const;
export type SendKind = (typeof SEND_KINDS)[number];
export function isSendKind(value: unknown): value is SendKind {
  return SEND_KINDS.includes(value as SendKind);
}

// what opened a session: a person's chat, or an automation's run
export const SESSION_ORIGINS = ["chat", "automation"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];
export function isSessionOrigin(value: unknown): value is SessionOrigin {
  return SESSION_ORIGINS.includes(value as SessionOrigin);
}

// what made an automation's event: its schedule, or someone's Run now
export const EVENT_SOURCES = ["schedule", "manual"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
// an event opened a run, or was skipped with a reason
export const EVENT_OUTCOMES = ["run", "skipped"] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];
// an automation's runs narrowed on its page
export const RUN_FILTERS = ["failed", "manual"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];
export function isRunFilter(value: unknown): value is RunFilter {
  return RUN_FILTERS.includes(value as RunFilter);
}
// how many next fires a schedule preview answers
export const PREVIEW_FIRES = 5;

// an automation's schedule is a five-field cron expression in an IANA
// zone; the server parses both and its 400 is the rule's only words
export const MAX_SCHEDULE = 100;
export const MAX_TZ = 64;
// the zone a user starts in when nobody picked one
export const DEFAULT_TZ = "UTC";
// an IANA zone the runtime knows, links such as UTC included
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > MAX_TZ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
// how long an automation's runs are kept, in days
export const RETENTION_DAYS = { min: 1, max: 365, default: 30 } as const;
export const MAX_MEMORY_GUIDANCE = 2000;

export const MESSAGE_KINDS = ["user", "reply", "tool", "summary"] as const;
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
// a title is one line by the same rule as a full name
export const hasLineBreak = (value: string) => LINE_BREAK.test(value);
// the stream's search box
export const MAX_SEARCH = 100;

// the tools that reach the web, each with a server-wide switch on the
// tools page
export const WEB_TOOLS = ["webfetch", "websearch", "visualize"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];
export function isWebTool(value: unknown): value is WebTool {
  return WEB_TOOLS.includes(value as WebTool);
}

// the tools the server writes itself, besides the web ones, by name;
// none has a switch, each follows what its send has
export const BUILTIN_TOOLS = [
  "bash",
  "datetime",
  "mcp_call",
  "mcp_describe",
  "memory_edit",
  "session_read",
  "sessions_list",
  "skill",
  "skill_file",
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

// the services websearch can run on; the key file carries the name
export const SEARCH_PROVIDERS = ["exa", "firecrawl", "tavily"] as const;
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
  "toolWorkTokens",
  "contextReserve",
  "summaryMaxTokens",
  "callTimeoutMs",
  "resultCut",
  "maxBashCalls",
  "maxFetches",
  "maxSearches",
  "fetchBodyBytes",
  "searchBodyBytes",
  "fetchDeadlineMs",
  "searchDeadlineMs",
  "runDeadlineMs",
  "sendDeadlineMs",
  "memoryPhaseMs",
  "memoryPhaseRounds",
  "visualBytes",
  "visualSendBytes",
  "maxVisuals",
  "knowledgeFileBytes",
  "knowledgeFiles",
  "knowledgeProjectBytes",
  "knowledgeVersions",
  "knowledgeHistoryBytes",
  "knowledgeHistoryDays",
  "scratchBytes",
  "scratchFiles",
  "scratchIdleDays",
  "uploadBytes",
  "uploadFiles",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
export function isLimitName(value: unknown): value is LimitName {
  return LIMIT_NAMES.includes(value as LimitName);
}

// what a limit's number counts; the page turns ms and bytes into words
export const LIMIT_UNITS = [
  "count",
  "ms",
  "bytes",
  "chars",
  "tokens",
  "days",
] as const;
export type LimitUnit = (typeof LIMIT_UNITS)[number];

// where a limit applies: over the whole send, to one tool call, or to
// a project's knowledge base, a storage cap read at each write
export const LIMIT_SCOPES = ["send", "call", "knowledge"] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

// a skill's name, the Agent Skills rule: lowercase ASCII letters, digits
// and hyphens, no hyphen at either end and none doubled, 1 to 64.
// Stricter than isName, since a skill written for any client obeys it
export const MAX_SKILL_NAME = 64;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function isSkillName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_SKILL_NAME &&
    SKILL_NAME_RE.test(value)
  );
}
// the specification's caps on the fields the catalog shows
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_COMPATIBILITY = 500;
// the Claude API's cap per request; recall drops past it
export const MAX_SKILLS_PER_AGENT = 20;

// the window an admin may state for a model its catalog does not
// describe, in tokens
export const MIN_CONTEXT_LENGTH = 1_024;
export const MAX_CONTEXT_LENGTH = 10_000_000;

// where a skill came from: a GitHub directory, a tarball with a path
// inside it, a site's discovery index, or one raw SKILL.md
export const SKILL_SOURCES = ["github", "archive", "index", "file"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];
export function isSkillSource(value: unknown): value is SkillSource {
  return SKILL_SOURCES.includes(value as SkillSource);
}

// the two tools an agent's skills bring to a send, never on the Tools
// page: `skill` loads a body, `skill_file` reads one of its files
export const SKILL_TOOLS = ["skill", "skill_file"] as const;
export type SkillTool = (typeof SKILL_TOOLS)[number];
export function isSkillTool(value: unknown): value is SkillTool {
  return SKILL_TOOLS.includes(value as SkillTool);
}
