// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pages the user opened last, as the rail lists them: which pages
// are recorded, the row each one makes, where it goes in the list and
// how a stored list is read back. Pure, so every rule runs on fixtures.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { ExternalTaskRow } from "../../shared/contracts/external-task.ts";
import type { SessionSummary } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { iconStatus } from "../feed/Row.model.ts";
import {
  automationHref,
  chatHref,
  externalTaskHref,
  knowledgeFileHref,
  runHref,
} from "../lib/hrefs.ts";
import type { IconName } from "../lib/icons.tsx";
import { channelName } from "../lib/names.ts";

export const RECENT_MAX = 5;

export const RECENT_KINDS = [
  "chat",
  "channel",
  "run",
  "automation",
  "task",
  "file",
] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

// what is stored: the kind, the object's id and its project, never a
// link, so a stored value can only ever lead to a page of the app
export type RecentRow = {
  kind: RecentKind;
  // a session, an automation, an external task or a knowledge file
  id: string;
  projectId: string;
  // a run's automation, whose runs share one row; null for any other
  // kind, and for a run whose automation was deleted
  automationId: string | null;
  // a chat's or a task's title, a channel's project name, an
  // automation's or a run's automation's name, a file's path
  title: string;
};

const ICONS: Record<RecentKind, IconName> = {
  chat: "chat",
  channel: "channel",
  run: "bolt",
  automation: "clock",
  task: "task",
  file: "file-text",
};

export const recentIcon = (row: RecentRow): IconName => ICONS[row.kind];

// a run's title is its automation's name, so the words say it is a
// run; a channel's is its project's, drawn as the channel
export const recentText = (row: RecentRow): string =>
  row.kind === "run"
    ? `Run of ${row.title}`
    : row.kind === "channel"
      ? channelName(row.title)
      : row.title;

export function recentHref(row: RecentRow): string {
  switch (row.kind) {
    case "chat":
    case "channel":
      return chatHref(row.id);
    case "run":
      return runHref(row.id);
    case "automation":
      return automationHref(row.id);
    case "task":
      return externalTaskHref(row.id);
    case "file":
      return knowledgeFileHref(row.projectId, row.id);
  }
}

// one row per key: every run of an automation shares its automation's
export const recentKey = (row: RecentRow): string =>
  row.kind === "run" && row.automationId !== null
    ? `runs:${row.automationId}`
    : `${row.kind}:${row.id}`;

// the object a page shows, before its row is read. A chat, a channel
// and a run are one session until the row says which; an automation's
// edit page is part of its visit but never recorded
export type RecentPage = {
  kind: "session" | "automation" | "task" | "file";
  id: string;
  record: boolean;
};

const PAGES: [RegExp, RecentPage["kind"], boolean][] = [
  [/^\/(?:chat|run)\/([^/]+)$/, "session", true],
  [/^\/automations\/([^/]+)(?:\/memory)?$/, "automation", true],
  [/^\/automations\/([^/]+)\/edit$/, "automation", false],
  [/^\/external-tasks\/([^/]+)$/, "task", true],
  [/^\/projects\/[^/]+\/knowledge\/files\/([^/]+)$/, "file", true],
];

export function recentPage(pathname: string): RecentPage | null {
  for (const [re, kind, record] of PAGES) {
    const hit = re.exec(pathname);
    if (hit === null) continue;
    try {
      return { kind, id: decodeURIComponent(hit[1]), record };
    } catch {
      return null;
    }
  }
  return null;
}

// a visit is one object on screen, whichever of its tabs
export const visitKey = (page: RecentPage): string => `${page.kind}:${page.id}`;

// the rows the pages read, as Recent holds them
export const sessionRecent = (s: {
  id: string;
  projectId: string;
  origin: "chat" | "automation" | "channel";
  automationId: string | null;
  title: string;
}): RecentRow =>
  s.origin === "automation"
    ? {
        kind: "run",
        id: s.id,
        projectId: s.projectId,
        automationId: s.automationId,
        title: s.title,
      }
    : {
        kind: s.origin === "channel" ? "channel" : "chat",
        id: s.id,
        projectId: s.projectId,
        automationId: null,
        // a channel's is its project's name, drawn by recentText()
        title: s.title,
      };

type Named = { id: string; projectId: string };

export const automationRecent = (a: Named & { name: string }): RecentRow => ({
  kind: "automation",
  id: a.id,
  projectId: a.projectId,
  automationId: null,
  title: a.name,
});

export const taskRecent = (t: Named & { title: string }): RecentRow => ({
  kind: "task",
  id: t.id,
  projectId: t.projectId,
  automationId: null,
  title: t.title,
});

export const fileRecent = (f: Named & { name: string }): RecentRow => ({
  kind: "file",
  id: f.id,
  projectId: f.projectId,
  automationId: null,
  title: f.name,
});

export const sameRow = (a: RecentRow, b: RecentRow): boolean =>
  a.kind === b.kind &&
  a.id === b.id &&
  a.projectId === b.projectId &&
  a.automationId === b.automationId &&
  a.title === b.title;

// the page just opened goes first, once, under its latest title
export function pushRecent(list: RecentRow[], row: RecentRow): RecentRow[] {
  const key = recentKey(row);
  return [row, ...list.filter((r) => recentKey(r) !== key)].slice(
    0,
    RECENT_MAX,
  );
}

// a page opened from Recent, or read again in the same visit: its row
// takes the latest title and link in its place, so the list never
// moves under the pointer
export function keepRecent(list: RecentRow[], row: RecentRow): RecentRow[] {
  const key = recentKey(row);
  const at = list.findIndex((r) => recentKey(r) === key);
  if (at === -1) return pushRecent(list, row);
  return list.map((r, i) => (i === at ? row : r));
}

const isKind = (value: unknown): value is RecentKind =>
  (RECENT_KINDS as readonly unknown[]).includes(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

function isRow(value: unknown): value is RecentRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    isKind(r.kind) &&
    nonEmpty(r.id) &&
    nonEmpty(r.projectId) &&
    (r.automationId === null ||
      (r.kind === "run" && nonEmpty(r.automationId))) &&
    typeof r.title === "string"
  );
}

// a stored list read back without trusting it: a row of the wrong
// shape or kind is dropped, and so is a second row of one key
export function readRecent(raw: string | null): RecentRow[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentRow[] = [];
  const keys = new Set<string>();
  for (const value of parsed) {
    if (!isRow(value)) continue;
    const row: RecentRow = {
      kind: value.kind,
      id: value.id,
      projectId: value.projectId,
      automationId: value.automationId,
      title: value.title,
    };
    const key = recentKey(row);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(row);
    if (out.length === RECENT_MAX) break;
  }
  return out;
}

// a held row follows its object: renamed or dropped where it stands,
// never moved or added. The same list comes back when nothing changed
function change(
  list: RecentRow[],
  hit: (row: RecentRow) => boolean,
  title: string | null,
): RecentRow[] {
  if (!list.some((r) => hit(r) && (title === null || r.title !== title))) {
    return list;
  }
  return title === null
    ? list.filter((r) => !hit(r))
    : list.map((r) => (hit(r) ? { ...r, title } : r));
}

const isSession = (row: RecentRow, id: string) =>
  (row.kind === "chat" || row.kind === "channel" || row.kind === "run") &&
  row.id === id;

// a frame of a project the user sees, whatever page is open. A run's
// own session frame changes nothing: its title is its automation's
// name, which the automation frame carries. A channel's follows its
// project's rename
export function recentFrame(list: RecentRow[], ev: SocketEvent): RecentRow[] {
  switch (ev.type) {
    case "session": {
      const s = ev.session;
      if (s.origin === "automation") return list;
      return change(list, (r) => r.kind === s.origin && r.id === s.id, s.title);
    }
    case "automation": {
      const a = ev.automation;
      return change(
        list,
        (r) =>
          (r.kind === "automation" && r.id === a.id) ||
          (r.kind === "run" && r.automationId === a.id),
        a.name,
      );
    }
    case "externalTask":
      return change(
        list,
        (r) => r.kind === "task" && r.id === ev.task.id,
        ev.task.title,
      );
    case "knowledge":
      return change(
        list,
        (r) => r.kind === "file" && r.id === ev.file.id,
        ev.deleted ? null : ev.file.name,
      );
    case "deleted":
      return change(list, (r) => isSession(r, ev.sessionId), null);
    case "automationDeleted":
      return change(
        list,
        (r) =>
          (r.kind === "automation" && r.id === ev.automationId) ||
          (ev.runs && r.kind === "run" && r.automationId === ev.automationId),
        null,
      );
    case "externalTaskDeleted":
      return change(list, (r) => r.kind === "task" && r.id === ev.taskId, null);
    case "revoked":
      return change(list, (r) => r.projectId === ev.projectId, null);
    default:
      return list;
  }
}

// a page that answered not found takes its row out: a delete or a lost
// project the tab missed while closed. A run's row goes only when it
// links to the run that is gone
export function dropRecent(list: RecentRow[], page: RecentPage): RecentRow[] {
  const kind = page.kind;
  return change(
    list,
    (r) =>
      kind === "session"
        ? isSession(r, page.id)
        : r.kind === kind && r.id === page.id,
    null,
  );
}

// what a page shows for its failure: a 404 is not found, a hidden
// project included; words are the page closed by a delete or a revoke
export const notFound = (
  failure: { status: number | null } | string | null,
): boolean =>
  typeof failure === "string" || (failure !== null && failure.status === 404);

// a row's live status: only what asks for action is coloured, since
// the rail is quieter than the feed; done and stopped stay plain
export type RecentTone = "running" | "failed" | "attention";
export type RecentStatus = { tone: RecentTone | null; paused: boolean };
export const PLAIN: RecentStatus = { tone: null, paused: false };

// held in memory only, keyed by the object a row links to, so a run's
// row follows only its own run, never another of its automation
export type RecentStatuses = Readonly<Record<string, RecentStatus>>;
export const statusKey = (row: RecentRow): string => `${row.kind}:${row.id}`;

const tone = (status: string): RecentTone | null =>
  status === "running" || status === "failed" || status === "attention"
    ? status
    : null;

// a chat, a channel and a run: the feed's icon colour
export const sessionStatus = (
  s: Pick<SessionSummary, "attention" | "status">,
): RecentStatus => ({ tone: tone(iconStatus(s)), paused: false });

// an automation: as on the Automations list, coloured only while its
// last run is running or failed, paused while suspended
export const automationStatus = (
  a: Pick<AutomationSummary, "suspendedAt" | "lastRunStatus">,
): RecentStatus => ({
  tone:
    a.lastRunStatus === "running" || a.lastRunStatus === "failed"
      ? a.lastRunStatus
      : null,
  paused: a.suspendedAt !== null,
});

// an external task: awaiting input is the one state that asks for
// action; the ring of its other states is the task page's
export const taskStatus = (
  t: Pick<ExternalTaskRow, "state">,
): RecentStatus => ({
  tone: t.state === "awaiting_input" ? "attention" : null,
  paused: false,
});

const sameStatus = (a: RecentStatus, b: RecentStatus) =>
  a.tone === b.tone && a.paused === b.paused;

// the same map comes back when nothing changed
export function withStatus(
  statuses: RecentStatuses,
  row: RecentRow,
  status: RecentStatus,
): RecentStatuses {
  const key = statusKey(row);
  const held = statuses[key];
  if (held !== undefined && sameStatus(held, status)) return statuses;
  return { ...statuses, [key]: status };
}

// a status leaves with its row
export function pruneStatus(
  statuses: RecentStatuses,
  list: RecentRow[],
): RecentStatuses {
  const keys = new Set(list.map(statusKey));
  const kept = Object.keys(statuses).filter((k) => keys.has(k));
  if (kept.length === Object.keys(statuses).length) return statuses;
  return Object.fromEntries(kept.map((k) => [k, statuses[k]]));
}

// a socket that was down missed frames, so a status held from before
// may be stale: only the page on screen keeps its own, since its load
// runs again on every open
export function reopenStatus(
  statuses: RecentStatuses,
  page: RecentPage | null,
): RecentStatuses {
  const keep = (key: string) =>
    page?.record === true &&
    (page.kind === "session"
      ? key === `chat:${page.id}` ||
        key === `channel:${page.id}` ||
        key === `run:${page.id}`
      : key === `${page.kind}:${page.id}`);
  const kept = Object.keys(statuses).filter(keep);
  if (kept.length === Object.keys(statuses).length) return statuses;
  return Object.fromEntries(kept.map((k) => [k, statuses[k]]));
}

// a frame's status for a held row; a frame never adds a row
export function statusFrame(
  statuses: RecentStatuses,
  list: RecentRow[],
  ev: SocketEvent,
): RecentStatuses {
  let row: RecentRow | undefined;
  let status: RecentStatus;
  switch (ev.type) {
    case "session":
      row = list.find((r) => isSession(r, ev.session.id));
      status = sessionStatus(ev.session);
      break;
    case "automation":
      row = list.find(
        (r) => r.kind === "automation" && r.id === ev.automation.id,
      );
      status = automationStatus(ev.automation);
      break;
    case "externalTask":
      row = list.find((r) => r.kind === "task" && r.id === ev.task.id);
      status = taskStatus(ev.task);
      break;
    default:
      return statuses;
  }
  return row === undefined ? statuses : withStatus(statuses, row, status);
}

// what a row draws: an automation's pause while suspended, else its
// kind's icon; a row with no status read yet draws plain
export const recentLook = (
  row: RecentRow,
  status: RecentStatus = PLAIN,
): { icon: IconName; tone: RecentTone | null } => ({
  icon: row.kind === "automation" && status.paused ? "pause" : recentIcon(row),
  tone: status.tone,
});
