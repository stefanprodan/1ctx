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

// Stored bytes of the rows created in one day of the zone; start is
// its local midnight
export type StorageDay = { day: string; start: number; bytes: number };

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

// The ranges the Overview reads, in days of the zone
export const OVERVIEW_RANGES = [7, 30, 90] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

// A day of the range: the sends started in it and how many of them
// failed, and the tokens of the rounds in it. start is its local
// midnight
export type OverviewDay = {
  day: string;
  start: number;
  sends: number;
  failed: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
};

// What a range adds up to. cost sums the rounds that carry one and
// pricedRounds counts them; cost is null when no round did
export type OverviewTotals = {
  sends: number;
  failed: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  rounds: number;
  pricedRounds: number;
  cost: number | null;
};

export const USAGE_BY = [
  "users",
  "agents",
  "models",
  "projects",
  "tasks",
] as const;
export type UsageBy = (typeof USAGE_BY)[number];

// A row of a breakdown, by prompt plus completion tokens. name is the
// username, the agent's name, the model, the team project's or the
// task's name; a project or a task in a personal project has id and
// name null and owner set. sub is a model's provider or a task's team
// project. cost is null when none of the row's rounds carried one
export type UsageRow = {
  id: string | null;
  name: string | null;
  owner: string | null;
  sub: string | null;
  tokens: number;
  sends: number;
  failed: number;
  cost: number | null;
};

// A provider's model over the range: its sends and failed sends, and
// the median and slowest length and median rounds of the ended ones
export type ModelHealth = {
  provider: string;
  model: string;
  sends: number;
  failed: number;
  medianMs: number | null;
  slowestMs: number | null;
  medianRounds: number | null;
};

// GET /api/admin/overview?tz=&days=7|30|90: the range's days, today
// last, its totals and the same over the range before it, the sends
// running now against their caps and the users with an open socket,
// the ten largest rows of each breakdown, the ten models with the most
// sends, and the instance's counts, as of readAt. The range is read at
// most once a minute per zone and range; now is read every time
export type OverviewResponse = {
  readAt: number;
  days: OverviewDay[];
  totals: OverviewTotals;
  before: OverviewTotals;
  now: {
    chats: number;
    chatsCap: number;
    runs: number;
    runsCap: number;
    online: number;
  };
  by: Record<UsageBy, UsageRow[]>;
  models: ModelHealth[];
  instance: {
    version: string;
    startedAt: number;
    users: number;
    projects: number;
    agents: number;
    tasks: number;
    servers: number;
    databaseBytes: number;
  };
};
