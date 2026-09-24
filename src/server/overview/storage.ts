// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage answer from one scan: the tables grouped into the areas a
// person knows, the days of the caller's zone laid over the scan's
// quarter hours, the largest rows and the retention lists. A personal
// project is counted everywhere and named nowhere: its rows carry the
// owner's username and no id, name or title.

import type {
  LargestRow,
  RetentionCleaned,
  RetentionKept,
  StorageArea,
  StorageAreaKey,
  StorageDay,
  StorageResponse,
  StorageTable,
  StoredPart,
} from "../../shared/api/admin.ts";
import { daysWindow } from "../usage/index.ts";
import type {
  AutomationRow,
  ProjectRow,
  ScanResult,
  SessionSum,
} from "./scan.ts";
import { SLOT_MS } from "./scan.ts";

export const STORAGE_DAYS = 30;

// every table the migrations create in exactly one area; the test
// checks it against the schema. sqlite_schema and migrations are the
// file's own
export const STORAGE_TABLES: Record<StorageAreaKey, readonly string[]> = {
  chats: ["sessions", "messages", "sends", "opened_files"],
  knowledge: ["knowledge_files", "knowledge_versions"],
  uploads: [
    "session_uploads",
    "session_upload_files",
    "upload_staged",
    "upload_staged_files",
  ],
  scratch: ["session_scratch", "session_scratch_files"],
  mcp: ["mcp_kept_files", "mcp_digests"],
  usage: ["usage"],
  skills: ["skills", "skill_files", "agent_skills"],
  memory: ["memory_notes", "automation_memory_reads"],
  config: [
    "users",
    "logins",
    "projects",
    "memberships",
    "providers",
    "agents",
    "tools",
    "limits",
    "automations",
    "mcp_servers",
    "mcp_tools",
    "agent_servers",
    "credentials",
    "credential_projects",
    "migrations",
    "sqlite_schema",
  ],
};

export type StorageLimits = {
  scratchIdleDays: number;
  knowledgeHistoryDays: number;
};

const LARGEST = 10;
const PARTS = 2;

function areaOf(table: string): StorageAreaKey {
  for (const key of Object.keys(STORAGE_TABLES) as StorageAreaKey[]) {
    if (STORAGE_TABLES[key].includes(table)) return key;
  }
  return "config";
}

const byBytes = <T extends { bytes: number }>(a: T, b: T) => b.bytes - a.bytes;

function areas(result: ScanResult): StorageArea[] {
  const bytes = new Map(result.pages.map((row) => [row.name, row.bytes]));
  const out = new Map<StorageAreaKey, StorageArea>();
  const area = (key: StorageAreaKey): StorageArea => {
    let entry = out.get(key);
    if (entry === undefined) {
      entry = {
        key,
        bytes: 0,
        rows: 0,
        tables: [],
        indexes: { count: 0, bytes: 0 },
      };
      out.set(key, entry);
    }
    return entry;
  };
  const named = new Set<string>();
  const addTable = (key: StorageAreaKey, table: StorageTable) => {
    named.add(table.name);
    const entry = area(key);
    entry.tables.push(table);
    entry.bytes += table.bytes;
    entry.rows += table.rows;
  };
  for (const key of Object.keys(STORAGE_TABLES) as StorageAreaKey[]) {
    for (const name of STORAGE_TABLES[key]) {
      addTable(key, {
        name,
        bytes: bytes.get(name) ?? 0,
        rows: result.rows[name] ?? 0,
      });
    }
  }
  for (const row of result.pages) {
    if (row.kind === "index") {
      const entry = area(areaOf(row.table));
      entry.indexes.count++;
      entry.indexes.bytes += row.bytes;
      entry.bytes += row.bytes;
    } else if (!named.has(row.name)) {
      // a table the map does not know is still on disk somewhere
      addTable("config", {
        name: row.name,
        bytes: row.bytes,
        rows: result.rows[row.name] ?? 0,
      });
    }
  }
  for (const entry of out.values()) entry.tables.sort(byBytes);
  return [...out.values()].sort(byBytes);
}

// the scan's quarter hours laid on the zone's days: 60 of them, the
// last 30 as the days and the first 30 summed as before
function days(
  result: ScanResult,
  timeZone: string,
): { days: StorageDay[]; before: number } {
  const window = daysWindow(result.readAt, timeZone, STORAGE_DAYS * 2);
  const bounds = [...window.starts, window.until];
  const totals = new Array<number>(bounds.length - 1).fill(0);
  const rows = new Array<number>(bounds.length - 1).fill(0);
  let day = 0;
  for (const [slot, bytes, count] of result.slots) {
    const at = slot * SLOT_MS;
    if (at < bounds[0]!) continue;
    while (day < totals.length && at >= bounds[day + 1]!) day++;
    if (day >= totals.length) break;
    totals[day]! += bytes;
    rows[day]! += count;
  }
  const before = totals
    .slice(0, STORAGE_DAYS)
    .reduce((sum, bytes) => sum + bytes, 0);
  return {
    days: window.days.slice(STORAGE_DAYS).map((label, i) => ({
      day: label,
      start: window.starts[STORAGE_DAYS + i]!,
      bytes: totals[STORAGE_DAYS + i]!,
      rows: rows[STORAGE_DAYS + i]!,
    })),
    before,
  };
}

type Parts = Partial<Record<StoredPart, number>>;

const partsOf = (parts: Parts): LargestRow["parts"] =>
  (Object.entries(parts) as [StoredPart, number][])
    .filter(([, bytes]) => bytes > 0)
    .map(([part, bytes]) => ({ part, bytes }))
    .sort(byBytes)
    .slice(0, PARTS);

const totalOf = (parts: Parts): number =>
  Object.values(parts).reduce((sum, bytes) => sum + bytes, 0);

const add = (parts: Parts, part: StoredPart, bytes: number) => {
  parts[part] = (parts[part] ?? 0) + bytes;
};

// what the session's rows hold, under the part its origin gives
function sessionParts(session: SessionSum, into: Parts = {}): Parts {
  const own = session.origin === "chat" ? "chats" : "runs";
  add(into, own, session.messageBytes + session.openedBytes);
  add(into, "uploads", session.uploadBytes);
  add(into, "scratch", session.scratchBytes);
  add(into, "mcp", session.mcpBytes);
  return into;
}

function naming(
  project: ProjectRow | undefined,
  own: { id: string; name: string },
  inProject: boolean,
): Pick<LargestRow, "id" | "name" | "project" | "owner"> {
  if (project === undefined || project.kind === "personal") {
    return {
      id: null,
      name: null,
      project: null,
      owner: project?.owner ?? null,
    };
  }
  if (inProject) {
    return { id: own.id, name: own.name, project: project.name, owner: null };
  }
  return { id: own.id, name: own.name, project: null, owner: null };
}

const top = (rows: LargestRow[]): LargestRow[] =>
  rows
    .filter((row) => row.bytes > 0)
    .sort(byBytes)
    .slice(0, LARGEST);

function largest(result: ScanResult): StorageResponse["largest"] {
  const projects = new Map(result.projects.map((row) => [row.id, row]));
  const projectParts = new Map<string, Parts>();
  const partsFor = (projectId: string): Parts => {
    let parts = projectParts.get(projectId);
    if (parts === undefined) {
      parts = {};
      projectParts.set(projectId, parts);
    }
    return parts;
  };
  const chats: LargestRow[] = [];
  const runs = new Map<string, { parts: Parts; count: number }>();
  for (const session of result.sessions) {
    sessionParts(session, partsFor(session.projectId));
    if (session.origin === "chat") {
      const parts = sessionParts(session);
      chats.push({
        ...naming(
          projects.get(session.projectId),
          {
            id: session.id,
            name: session.title,
          },
          true,
        ),
        bytes: totalOf(parts),
        parts: partsOf(parts),
        messages: session.messages,
        runs: null,
        retentionDays: null,
      });
    } else if (session.automationId !== null) {
      const entry = runs.get(session.automationId) ?? { parts: {}, count: 0 };
      sessionParts(session, entry.parts);
      entry.count++;
      runs.set(session.automationId, entry);
    }
  }
  for (const row of result.knowledge) {
    const parts = partsFor(row.projectId);
    add(parts, "knowledge", row.files + row.liveVersions);
    add(parts, "history", row.deletedVersions);
  }
  const tasks = result.automations.map((automation: AutomationRow) => {
    const entry = runs.get(automation.id) ?? { parts: {}, count: 0 };
    return {
      ...naming(projects.get(automation.projectId), automation, true),
      bytes: totalOf(entry.parts),
      parts: partsOf(entry.parts),
      messages: null,
      runs: entry.count,
      retentionDays: automation.retentionDays,
    };
  });
  const projectRows = result.projects.map((project) => {
    const parts = projectParts.get(project.id) ?? {};
    return {
      ...naming(project, project, false),
      bytes: totalOf(parts),
      parts: partsOf(parts),
      messages: null,
      runs: null,
      retentionDays: null,
    };
  });
  return { projects: top(projectRows), chats: top(chats), tasks: top(tasks) };
}

// Kept is what only a delete removes, cleaned what a sweep or a task's
// retention takes. A run whose task is gone is a chat's equal; a run
// of a living task goes with its kept MCP files and its usage rows.
// Rows without a byte count (usage, logins, the rest) are their
// table's pages on disk, and the runs' usage is the table's pages by
// the share of its rows that are theirs.
function retention(
  result: ScanResult,
  limits: StorageLimits,
): StorageResponse["retention"] {
  const table = (name: string) =>
    result.pages.find((row) => row.kind === "table" && row.name === name)
      ?.bytes ?? 0;
  const usagePages = table("usage");
  const runUsage =
    result.usage.rows === 0
      ? 0
      : Math.round((usagePages * result.usage.runRows) / result.usage.rows);
  const kept: Record<RetentionKept, number> = {
    chats: 0,
    knowledge: 0,
    uploads: 0,
    mcp: 0,
    usage: usagePages - runUsage,
    rest: 0,
  };
  const cleaned: Record<RetentionCleaned, number> = {
    runs: runUsage,
    scratch: 0,
    history: 0,
    staging: result.staging,
    digests: result.digests,
    logins: table("logins"),
  };
  for (const session of result.sessions) {
    const own = session.messageBytes + session.openedBytes;
    if (session.automationId === null) {
      kept.chats += own;
      kept.mcp += session.mcpBytes;
    } else {
      cleaned.runs += own + session.mcpBytes;
    }
    kept.uploads += session.uploadBytes;
    cleaned.scratch += session.scratchBytes;
  }
  for (const row of result.knowledge) {
    kept.knowledge += row.files + row.liveVersions;
    cleaned.history += row.deletedVersions;
  }
  for (const key of ["skills", "memory", "config"] as const) {
    for (const name of STORAGE_TABLES[key]) {
      if (name !== "logins") kept.rest += table(name);
    }
  }
  const retentions = new Set(result.automations.map((a) => a.retentionDays));
  const runDays = retentions.size === 1 ? [...retentions][0]! : null;
  const cleanedDays: Record<RetentionCleaned, number | null> = {
    runs: runDays,
    scratch: limits.scratchIdleDays,
    history: limits.knowledgeHistoryDays,
    staging: null,
    digests: null,
    logins: null,
  };
  return {
    kept: (Object.keys(kept) as RetentionKept[]).map((key) => ({
      key,
      bytes: kept[key],
    })),
    cleaned: (Object.keys(cleaned) as RetentionCleaned[]).map((key) => ({
      key,
      bytes: cleaned[key],
      days: cleanedDays[key],
    })),
  };
}

export function storageResponse(
  result: ScanResult,
  timeZone: string,
  limits: StorageLimits,
): StorageResponse {
  return {
    readAt: result.readAt,
    file: result.file,
    areas: areas(result),
    ...days(result, timeZone),
    largest: largest(result),
    retention: retention(result, limits),
  };
}
