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
// admin sets it (the scratch and history limits, a task's retention
// when every task has the same), null when it is fixed or varies
export type RetentionKept =
  | "chats"
  | "knowledge"
  | "uploads"
  | "mcp"
  | "usage"
  | "rest";
export type RetentionCleaned =
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
export type OverviewDay = {
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
};

// What the days, or all time, add up to. cost sums the rounds that
// carry one and pricedRounds counts them; cost is null when no round did
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
};

export const USAGE_BY = ["projects", "agents"] as const;
export type UsageBy = (typeof USAGE_BY)[number];

// A row of a breakdown, by prompt plus completion tokens. name is the
// team project's or the agent's; a personal project has id and name
// null and owner set
export type UsageRow = {
  id: string | null;
  name: string | null;
  owner: string | null;
  tokens: number;
  turns: number;
  runs: number;
};

// A provider's model over the days: its chat turns, and the median and
// slowest length of the ended ones
export type TurnLength = {
  provider: string;
  model: string;
  turns: number;
  medianMs: number | null;
  slowestMs: number | null;
};

// GET /api/admin/overview?tz=: the zone's last OVERVIEW_DAYS days, today
// last, and their totals, the ten largest rows of each breakdown, the
// ten models with the most turns, all time with the first send's start
// (null before any), and the instance, as of readAt. Read at most once
// a minute per zone
export type OverviewResponse = {
  readAt: number;
  days: OverviewDay[];
  totals: OverviewTotals;
  by: Record<UsageBy, UsageRow[]>;
  lengths: TurnLength[];
  all: OverviewTotals & { since: number | null };
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

export const OVERVIEW_DAYS = 30;

// the server's load sampled every LOAD_SAMPLE_MS, LOAD_SAMPLES kept
export const LOAD_SAMPLE_MS = 5_000;
export const LOAD_SAMPLES = 180;

// GET /api/admin/load: the process now, read from memory at each
// request. chats and runs are the sends running in each pool against
// their process caps; online the users with an open socket; waiting
// the automations whose fire is past due by WAIT_GRACE_MS. cpu is the
// process's share of the cores it may use, 0 to 1; rss its resident
// bytes against memoryLimit, a container's limit when contained, else
// the host's memory. The samples are oldest first, the last the newest
export type LoadResponse = {
  at: number;
  chats: number;
  chatsCap: number;
  runs: number;
  runsCap: number;
  online: number;
  automations: number;
  waiting: number;
  cores: number;
  memoryLimit: number;
  contained: boolean;
  samples: { at: number[]; cpu: number[]; rss: number[] };
};
