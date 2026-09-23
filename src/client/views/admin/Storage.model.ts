// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Storage page's words and numbers, pure: sizes, shares, the bars
// of the areas and of one area's tables, the size over the days, and
// what each large row and each retention line says.

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

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

// a size as its number and its unit, three figures at most: "212", "MB"
export function sizeParts(bytes: number): { figure: string; unit: string } {
  const n = Math.max(0, bytes);
  const three = (v: number) => String(Number(v.toPrecision(3)));
  if (n < KB) return { figure: String(Math.round(n)), unit: "B" };
  if (n < MB) return { figure: three(n / KB), unit: "KB" };
  if (n < GB) return { figure: three(n / MB), unit: "MB" };
  return { figure: three(n / GB), unit: "GB" };
}

// "212 MB"
export function size(bytes: number): string {
  const { figure, unit } = sizeParts(bytes);
  return `${figure} ${unit}`;
}

// "12%", "<1%" for a sliver that is there, "0%" for none
export function share(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = part / whole;
  if (p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

// "48,210"
export const commas = (n: number): string => n.toLocaleString("en-GB");

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

const plural = (n: number, one: string, many: string) =>
  `${commas(n)} ${n === 1 ? one : many}`;

// what the file holds in areas: the bytes, the share of the areas'
// sum, and the words while one is under the pointer
export function areaBars(areas: StorageArea[]) {
  const total = areas.reduce((sum, a) => sum + a.bytes, 0);
  return areas.map((a) => ({
    key: a.key,
    name: AREA_NAMES[a.key],
    value: a.bytes,
    size: size(a.bytes),
    share: share(a.bytes, total),
    hint: `${AREA_NAMES[a.key]} · ${size(a.bytes)} on disk · ${plural(a.rows, "row", "rows")}`,
  }));
}

// the words at the foot of the areas
export function areasFoot(areas: StorageArea[]): string {
  const total = areas.reduce((sum, a) => sum + a.bytes, 0);
  const rows = areas.reduce((sum, a) => sum + a.rows, 0);
  return `${size(total)} on disk in ${areas.length} areas · ${plural(rows, "row", "rows")}`;
}

// one area's tables, largest first, then its indexes as one faint line
export function tableBars(area: StorageArea) {
  const bars = area.tables.map((t) => ({
    key: t.name,
    name: t.name,
    value: t.bytes,
    size: size(t.bytes),
    hint: `${t.name} · ${plural(t.rows, "row", "rows")} · ${size(t.bytes)} on disk`,
    faint: false,
  }));
  const { count, bytes } = area.indexes;
  if (count > 0) {
    const name = plural(count, "index", "indexes");
    bars.push({
      key: "indexes",
      name,
      value: bytes,
      size: size(bytes),
      hint: `${name} · ${size(bytes)} on disk`,
      faint: true,
    });
  }
  return bars;
}

// the area picked, the largest when the pick is not in the answer
export function pickedArea(
  areas: StorageArea[],
  key: string | null,
): StorageArea | null {
  return areas.find((a) => a.key === key) ?? areas[0] ?? null;
}

// the file on disk at the end of each day: today is what it is now,
// and each day before it is that less the bytes added after it
export function sizeByDay(onDisk: number, days: StorageDay[]): number[] {
  const out = new Array<number>(days.length);
  let at = onDisk;
  for (let i = days.length - 1; i >= 0; i--) {
    out[i] = Math.max(0, at);
    at -= days[i].bytes;
  }
  return out;
}

export const added = (days: StorageDay[]): number =>
  days.reduce((sum, d) => sum + d.bytes, 0);

// "Tue 23 Sep"
export function dayWord(start: number): string {
  return new Date(start).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// the average a day, as the growth tile's figure: "+4.1", "MB a day"
export function perDay(bytes: number, days: number) {
  const { figure, unit } = sizeParts(days > 0 ? bytes / days : 0);
  return { figure: `+${figure}`, unit: `${unit} a day` };
}

export function freeWords(file: StorageFile): string {
  const free = file.freePages * file.pageSize;
  const vacuum = file.autoVacuum === "none" ? "off" : file.autoVacuum;
  return `${share(free, file.bytes)} of the file · auto vacuum ${vacuum}`;
}

// the faint line under the board
export function factsLine(file: StorageFile): string {
  const journal =
    file.journalMode === "wal" ? "WAL" : file.journalMode.toLowerCase();
  const parts = [
    file.name,
    `${plural(file.pages, "page", "pages")} of ${size(file.pageSize)}`,
    `${journal} journal`,
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

const partWords = (row: LargestRow, n: number) =>
  row.parts.slice(0, n).map((p) => `${PART_WORDS[p.part]} ${size(p.bytes)}`);

// where a chat or a task is: its team project, or whose personal one
const where = (row: LargestRow) =>
  row.owner !== null
    ? `of @${row.owner}`
    : row.project
      ? `#${row.project}`
      : "";

// A large row's words and where it leads. A personal project's rows
// name only their owner and lead nowhere.
export function largestLine(kind: LargestKind, row: LargestRow) {
  const personal = row.owner !== null;
  if (kind === "projects") {
    return {
      name: personal ? `personal of @${row.owner}` : (row.name ?? ""),
      mono: !personal,
      sub: partWords(row, 2).join(" · "),
      href: personal
        ? null
        : `/admin/projects?open=${encodeURIComponent(row.id ?? "")}`,
    };
  }
  if (kind === "chats") {
    const top = row.parts[0];
    const why =
      top === undefined || top.part === "chats"
        ? plural(row.messages ?? 0, "message", "messages")
        : partWords(row, 1)[0];
    return {
      name: personal
        ? "A chat in a personal project"
        : row.name || "Untitled chat",
      mono: false,
      sub: [where(row), why].filter(Boolean).join(" · "),
      href: personal ? null : `/chat/${encodeURIComponent(row.id ?? "")}`,
    };
  }
  const runs = row.runs ?? 0;
  const kept =
    row.retentionDays === null
      ? plural(runs, "run", "runs")
      : `${plural(runs, "run", "runs")} kept ${plural(row.retentionDays, "day", "days")}`;
  return {
    name: personal ? "A task in a personal project" : (row.name ?? ""),
    mono: !personal,
    sub: [where(row), kept].filter(Boolean).join(" · "),
    href: personal ? null : `/automations/${encodeURIComponent(row.id ?? "")}`,
  };
}

const KEPT: Record<RetentionKept, [string, string]> = {
  chats: ["Chats", "until deleted"],
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
  const d = days === null ? null : plural(days, "day", "days");
  switch (key) {
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
