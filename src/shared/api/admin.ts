// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the admin pages read about the instance, all for admins. A
// personal project is counted in every total but never named: a row
// in one carries its owner's username and no id, title or name.

// The groups the tables fall in, as a person knows them
export const STORAGE_AREAS = [
  "chats",
  "knowledge",
  "uploads",
  "scratch",
  "mcp",
  "usage",
  "skills",
  "memory",
  "config",
] as const;
export type StorageAreaKey = (typeof STORAGE_AREAS)[number];

// A table's pages on disk and its rows
export type StorageTable = { name: string; bytes: number; rows: number };

// An area on disk: its tables largest first, and its indexes together,
// never named. bytes counts both
export type StorageArea = {
  key: StorageAreaKey;
  bytes: number;
  rows: number;
  tables: StorageTable[];
  indexes: { count: number; bytes: number };
};

// The file and how SQLite keeps it. name is the file's base name,
// never a path; lastMigration is the id of the newest one applied
export type StorageFile = {
  name: string;
  bytes: number;
  walBytes: number;
  shmBytes: number;
  pageSize: number;
  pages: number;
  freePages: number;
  autoVacuum: "none" | "full" | "incremental";
  journalMode: string;
  sqliteVersion: string;
  lastMigration: string | null;
};

// The rows created in one day of the zone, of the tables that keep a
// creation time, and their stored bytes; start is its local midnight
export type StorageDay = {
  day: string;
  start: number;
  bytes: number;
  rows: number;
};

// What a large row's stored bytes are made of
export type StoredPart =
  | "chats"
  | "runs"
  | "knowledge"
  | "history"
  | "uploads"
  | "scratch"
  | "mcp";

// A project, a chat or a task by its stored bytes. In a personal
// project id and name are null and owner names whose it is; in a team
// project owner is null. project is the team project's name for a chat
// or a task, null for a project row and in a personal project. parts
// are the two largest, largest first. messages is a chat's, runs and
// retentionDays a task's, null elsewhere
export type LargestRow = {
  id: string | null;
  name: string | null;
  project: string | null;
  owner: string | null;
  bytes: number;
  parts: { part: StoredPart; bytes: number }[];
  messages: number | null;
  runs: number | null;
  retentionDays: number | null;
};

// Stored bytes by how long they stay. days is what sweeps them when an
// admin sets it (the scratch, history and archived chats limits, a
// task's retention when every task has the same), null when it is
// fixed or varies. Archived chats are the archived chats and the runs
// whose task is gone, which the chats sweep deletes
export type RetentionKept =
  | "chats"
  | "knowledge"
  | "uploads"
  | "mcp"
  | "usage"
  | "rest";
export type RetentionCleaned =
  | "archived"
  | "runs"
  | "scratch"
  | "history"
  | "staging"
  | "digests"
  | "logins";

// GET /api/admin/storage?tz=: the file, the areas on disk largest
// first, the stored bytes added a day over the last 30 days of the
// zone, today last, and over the 30 before them, the ten largest of
// each kind and the retention lists, all as of readAt. The answer is
// read at most once a minute
export type StorageResponse = {
  readAt: number;
  file: StorageFile;
  areas: StorageArea[];
  days: StorageDay[];
  before: number;
  largest: { projects: LargestRow[]; chats: LargestRow[]; tasks: LargestRow[] };
  retention: {
    kept: { key: RetentionKept; bytes: number }[];
    cleaned: { key: RetentionCleaned; bytes: number; days: number | null }[];
  };
};

// A day of the zone: the chat turns and the automation runs started in
// it and how many of each failed, and the tokens and the cost of the
// rounds in it. A turn is a send of a chat (a message, a regenerate, a
// compact), a run a send of a task. cost is null when no round of the
// day carried one. start is its local midnight
export type OverviewDay = TurnLengths & {
  day: string;
  start: number;
  turns: number;
  turnsFailed: number;
  runs: number;
  runsFailed: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cost: number | null;
  // the decisions answered, their input tokens, how many named a cost
  // and its sum, null when none did; apart from the rounds' cost
  decisions: number;
  decisionTokens: number;
  pricedDecisions: number;
  decisionCost: number | null;
  activeUsers: number;
};

export type TurnLengths = { medianMs: number | null; p95Ms: number | null };

// What the days add up to. cost sums the rounds that carry one and
// pricedRounds counts them; cost is null when no round did
export type OverviewTotals = {
  turns: number;
  turnsFailed: number;
  runs: number;
  runsFailed: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  rounds: number;
  pricedRounds: number;
  cost: number | null;
  // the decisions answered, their input tokens, how many named a cost
  // and its sum, null when none did; apart from the rounds' cost
  decisions: number;
  decisionTokens: number;
  pricedDecisions: number;
  decisionCost: number | null;
};

// A row of a breakdown, by prompt plus completion tokens. name is the
// team project's or the agent's; a personal project has id and name
// null and owner set. deleted is true for a project or an agent that
// is gone, whose usage stays: every deleted project is summed into one
// row with id, name and owner null, ranked like any other, and a
// retired agent keeps its own row and name
export type UsageRow = {
  id: string | null;
  name: string | null;
  owner: string | null;
  deleted: boolean;
  tokens: number;
  cost: number | null;
  turns: number;
  runs: number;
};

export type ModelUsage = {
  provider: string | null;
  model: string;
  tokens: number;
  cost: number | null;
  rounds: number;
};

export type DeciderUsage = {
  name: string;
  decisions: number;
  tokens: number;
  cost: number | null;
};

// GET /api/admin/overview?tz=&range=: the range's days in the zone,
// today last, and their totals, and the instance, as of readAt. 30d and
// 90d are the last 30 and 90 days, all every day from the first one
// with a send, a round or a decision (today alone before any); the
// range is 30d when not given. Read at most once every 25 seconds
// per zone and range
export type OverviewResponse = DaysAnswer & {
  range: OverviewRange;
  instance: {
    version: string;
    startedAt: number;
    users: number;
    projects: number;
    agents: number;
    automations: number;
    databaseBytes: number;
  };
};

// what the overview and the usage page share; turnLength and
// activeUsers are over every day
export type DaysAnswer = {
  readAt: number;
  days: OverviewDay[];
  totals: OverviewTotals;
  turnLength: TurnLengths;
  activeUsers: number;
};

// a rolling window's bounds, [since, until), and what it counted
export type Windowed<T> = { since: number; until: number } & T;

// cost is null when rounds ran and none was priced
export type SendTotals = {
  sends: number;
  tokens: number;
  cost: number | null;
};

// GET /api/agents/:id/usage, /api/providers/:id/usage,
// /api/projects/:id/usage (a team project) and /api/users/:id/usage (the
// personal project alone): the last 30 days
export type SendTotalsResponse = Windowed<SendTotals>;

export const OVERVIEW_RANGES = ["30d", "90d", "all"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export function isOverviewRange(value: unknown): value is OverviewRange {
  return OVERVIEW_RANGES.includes(value as OverviewRange);
}

// the server's load sampled every LOAD_SAMPLE_MS, LOAD_SAMPLES kept
export const LOAD_SAMPLE_MS = 5_000;
export const LOAD_SAMPLES = 180;

// GET /api/admin/load: the process now, read from memory at each
// request. chats and runs are the sends running, together against cap,
// the process's; scheduled the runs no user started, against
// scheduledCap, the share of cap they may hold; projectsFull the
// projects at their own cap; online the users with an open socket;
// waiting the automations whose fire is past due by WAIT_GRACE_MS; the
// queue's counts are the answer's one indexed read. cpu is the
// process's share of the cores it may use, 0 to 1; rss its resident
// bytes against memoryLimit, a container's limit when contained, else
// the host's memory. The samples are oldest first, the last the newest
export type LoadResponse = {
  at: number;
  chats: number;
  runs: number;
  cap: number;
  scheduled: number;
  scheduledCap: number;
  projectsFull: number;
  online: number;
  automations: number;
  waiting: number;
  // messages waiting behind a busy chat and those not sent, and the
  // oldest wait's start, null with none queued
  queued: number;
  notSent: number;
  oldestQueuedAt: number | null;
  cores: number;
  memoryLimit: number;
  contained: boolean;
  samples: { at: number[]; cpu: number[]; rss: number[] };
};

// GET /api/admin/usage?tz=&month=YYYY-MM: the month's days in the zone,
// up to today in this month, and their totals, the ten largest rows of
// each breakdown (models by tokens) and the deciders by decisions, as
// of readAt. since is the first send's start, null before any, so the
// page offers the months from it. Read at most once every 25 seconds
// per zone and month
export type UsageResponse = DaysAnswer & {
  month: string;
  since: number | null;
  by: { projects: UsageRow[]; agents: UsageRow[]; models: ModelUsage[] };
  deciders: DeciderUsage[];
};

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// What an admin should fix: an MCP server or a skill whose last refresh
// failed, at when it failed; a provider's, an MCP server's, the search
// service's or the SMTP server's key file missing; a credential's key
// missing or unusable; email that failed for good, named by the newest
// failure's word, at when it failed; link emails asked for at sign in
// paused by the hourly cap while email is on. name is the object's, the
// search service's for its key, the key file's for SMTP
export type AttentionKind =
  | "mcp-refresh"
  | "skill-refresh"
  | "provider-key"
  | "mcp-key"
  | "credential-key"
  | "credential-unusable"
  | "search-key"
  | "smtp-key"
  | "links-paused"
  | "email-failed";

export type AttentionItem = {
  kind: AttentionKind;
  name: string;
  at: number | null;
};

// GET /api/admin/attention: read at each request, keys first by kind
// and name, then the failures newest first; the outbox's queued and
// failed rows, null until email is set up
export type AttentionResponse = {
  items: AttentionItem[];
  email: { queued: number; failed: number } | null;
};
