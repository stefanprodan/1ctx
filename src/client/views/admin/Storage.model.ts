// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  LargestRow,
  RetentionCleaned,
  RetentionKept,
  StorageArea,
  StorageAreaKey,
  StorageDay,
  StorageFile,
  StoredPart,
} from "../../../shared/api/admin.ts";
import {
  count,
  dayMonth,
  pluralCommas,
  share,
  size,
  sizeParts,
} from "../../lib/format.ts";
import { adminProjectHref, automationHref, chatHref } from "../../lib/hrefs.ts";

export const AREA_NAMES: Record<StorageAreaKey, string> = {
  chats: "Chats",
  knowledge: "Knowledge",
  uploads: "Uploads",
  scratch: "Scratch",
  mcp: "MCP results",
  usage: "Usage",
  skills: "Skills",
  memory: "Memory",
  config: "Config",
};

function areaTotals(areas: StorageArea[]) {
  let bytes = 0;
  let rows = 0;
  let tables = 0;
  for (const a of areas) {
    bytes += a.bytes;
    rows += a.rows;
    tables += a.tables.length;
  }
  return { bytes, rows, tables };
}

export function areaBars(areas: StorageArea[]) {
  const total = areaTotals(areas).bytes;
  return areas.map((a) => ({
    key: a.key,
    name: AREA_NAMES[a.key],
    value: a.bytes,
    size: size(a.bytes),
    share: share(a.bytes, total),
    hint: `${AREA_NAMES[a.key]} · ${size(a.bytes)} · ${pluralCommas(a.rows, "row", "rows")}`,
  }));
}

export function areasFoot(areas: StorageArea[]): string {
  const { bytes: total, rows } = areaTotals(areas);
  return `${size(total)} in ${areas.length} areas · ${pluralCommas(rows, "row", "rows")}`;
}

export function tableBars(area: StorageArea) {
  const bars = area.tables.map((t) => ({
    key: t.name,
    name: t.name,
    value: t.bytes,
    size: size(t.bytes),
    hint: `${t.name} · ${pluralCommas(t.rows, "row", "rows")} · ${size(t.bytes)}`,
    faint: false,
  }));
  const { count, bytes } = area.indexes;
  if (count > 0) {
    const name = pluralCommas(count, "index", "indexes");
    bars.push({
      key: "indexes",
      name,
      value: bytes,
      size: size(bytes),
      hint: `${name} · ${size(bytes)}`,
      faint: true,
    });
  }
  return bars;
}

export function pickedArea(
  areas: StorageArea[],
  key: string | null,
): StorageArea | null {
  return areas.find((a) => a.key === key) ?? areas[0] ?? null;
}

// what the rows still here say about growth, never a history of the
// file, which checkpoints, deletes and free pages move on their own
export function addedByDay(days: StorageDay[]): number[] {
  let sum = 0;
  return days.map((d) => {
    sum += d.bytes;
    return sum;
  });
}

export function rowsTile(areas: StorageArea[]) {
  const { rows, tables } = areaTotals(areas);
  return {
    figure: count(rows),
    unit: rows === 1 ? "row" : "rows",
    sub: pluralCommas(tables, "table", "tables"),
  };
}

// a log scale, so a day of a few rows still shows beside a day of
// thousands; the words carry the counts
export const logHeights = (values: number[]): number[] =>
  values.map((v) => Math.log10(1 + Math.max(0, v)));

export const rowsDay = (day: StorageDay): string =>
  `${dayMonth(day.start)} · ${pluralCommas(day.rows, "row", "rows")}`;

export function perDay(bytes: number, days: number) {
  const { figure, unit } = sizeParts(days > 0 ? bytes / days : 0);
  return { figure: `+${figure}`, unit: `${unit} a day` };
}

export const growthDay = (start: number, total: number): string =>
  `${dayMonth(start)} · +${size(total)}`;

export function growthWords(before: number, days: number): string {
  const range = `last ${days} days`;
  if (before <= 0 || days <= 0) return range;
  return `${range} · was ${size(before / days)}`;
}

// a share of the size, which counts the log with the file
export function freeWords(file: StorageFile): string {
  const free = file.freePages * file.pageSize;
  return `${share(free, file.bytes + file.walBytes)} reusable`;
}

export function walWords(file: StorageFile): string {
  const total = file.bytes + file.walBytes;
  return share(file.walBytes, total);
}

export function factsLine(file: StorageFile): string {
  const journal =
    file.journalMode === "wal" ? "WAL" : file.journalMode.toLowerCase();
  const parts = [
    file.name,
    `${pluralCommas(file.pages, "page", "pages")} of ${size(file.pageSize)}`,
    `${journal} journal`,
    `auto vacuum ${file.autoVacuum === "none" ? "off" : file.autoVacuum}`,
  ];
  if (file.shmBytes > 0) parts.push(`shared memory ${size(file.shmBytes)}`);
  parts.push(`SQLite ${file.sqliteVersion}`);
  if (file.lastMigration) parts.push(`last migration ${file.lastMigration}`);
  return parts.join(" · ");
}

export type LargestKind = "projects" | "chats" | "tasks";

const PART_WORDS: Record<StoredPart, string> = {
  chats: "chats",
  runs: "runs",
  knowledge: "knowledge",
  history: "knowledge history",
  uploads: "uploads",
  scratch: "scratch",
  mcp: "MCP results",
};

// a size never breaks from its unit when a narrow line wraps
const partWords = (row: LargestRow, n: number) =>
  row.parts
    .slice(0, n)
    .map(
      (p) => `${PART_WORDS[p.part]} ${size(p.bytes).replace(" ", "\u00a0")}`,
    );

const where = (row: LargestRow) =>
  row.owner !== null
    ? `of @${row.owner}`
    : row.project
      ? `#${row.project}`
      : "";

// a personal project's rows name only their owner and lead nowhere
export function largestLine(kind: LargestKind, row: LargestRow) {
  const personal = row.owner !== null;
  if (kind === "projects") {
    return {
      name: personal ? `personal of @${row.owner}` : (row.name ?? ""),
      mono: !personal,
      sub: partWords(row, 2).join(" · "),
      href: personal ? null : adminProjectHref(row.id ?? ""),
    };
  }
  if (kind === "chats") {
    const top = row.parts[0];
    const why =
      top === undefined || top.part === "chats"
        ? pluralCommas(row.messages ?? 0, "message", "messages")
        : partWords(row, 1)[0];
    return {
      name: personal
        ? "A chat in a personal project"
        : row.name || "Untitled chat",
      mono: false,
      sub: [where(row), why].filter(Boolean).join(" · "),
      href: personal ? null : chatHref(row.id ?? ""),
    };
  }
  const runs = row.runs ?? 0;
  const kept =
    row.retentionDays === null
      ? pluralCommas(runs, "run", "runs")
      : `${pluralCommas(runs, "run", "runs")} kept ${pluralCommas(row.retentionDays, "day", "days")}`;
  return {
    name: personal ? "A task in a personal project" : (row.name ?? ""),
    mono: !personal,
    sub: [where(row), kept].filter(Boolean).join(" · "),
    href: personal ? null : automationHref(row.id ?? ""),
  };
}

const KEPT: Record<RetentionKept, [string, string]> = {
  chats: ["Chats", "not archived"],
  knowledge: ["Knowledge", "live files and versions"],
  uploads: ["Uploads", "with their chat"],
  mcp: ["MCP results", "with their chat"],
  usage: ["Usage", "one row per round"],
  rest: ["Skills, memory, config", "until removed"],
};

export function keptLine(key: RetentionKept) {
  const [name, sub] = KEPT[key];
  return { name, sub };
}

export function cleanedLine(key: RetentionCleaned, days: number | null) {
  const d = days === null ? null : pluralCommas(days, "day", "days");
  switch (key) {
    case "archived":
      return {
        name: "Archived chats",
        sub: d ? `after ${d}` : "when expired",
      };
    case "runs":
      return {
        name: "Runs",
        sub: d ? `after ${d}` : "by each task's retention",
      };
    case "scratch":
      return { name: "Scratch", sub: d ? `idle ${d}` : "when idle" };
    case "history":
      return {
        name: "Deleted file history",
        sub: d ? `after ${d}` : "when expired",
      };
    case "staging":
      return { name: "Upload staging", sub: "after 24 hours" };
    case "digests":
      return { name: "MCP digests", sub: "with the logins" };
    case "logins":
      return { name: "Logins", sub: "once expired" };
  }
}
