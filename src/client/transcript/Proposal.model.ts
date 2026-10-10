// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A proposal line's words: which automation calls draw one, what it
// says per action and state, the line diff of changed instructions,
// and the invisible characters drawn as marks.

import type {
  AutomationDraft,
  AutomationProposal,
  ProposalFields,
} from "../../shared/contracts/automation-draft.ts";
import type { SessionSummary } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import { scheduleWords } from "../../shared/schedule.ts";
import { AUTOMATION_TOOL } from "../../shared/words.ts";
import type { IconName } from "../lib/icons.tsx";
import { scheduleTitle } from "../views/projects/Schedule.model.ts";
import type { ReplyNode } from "./rows.ts";

export type ProposalAction = AutomationProposal["action"];

const ACTIONS: readonly string[] = [
  "create",
  "update",
  "suspend",
  "resume",
  "run",
] satisfies ProposalAction[];

export type ProposalCall = {
  action: ProposalAction;
  // a create's name, and the task any other action names
  name: string | null;
  taskId: string | null;
};

// what an automation call proposes; null for a read, another tool or
// arguments that do not parse
export function proposalCall(call: ToolCall): ProposalCall | null {
  if (call.name !== AUTOMATION_TOOL) return null;
  let args: { action?: unknown; name?: unknown; id?: unknown };
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  if (typeof args !== "object" || args === null) return null;
  if (typeof args.action !== "string" || !ACTIONS.includes(args.action)) {
    return null;
  }
  const action = args.action as ProposalAction;
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : null;
  return action === "create"
    ? { action, name: text(args.name), taskId: null }
    : { action, name: null, taskId: text(args.id) };
}

export const proposalAction = (call: ToolCall): ProposalAction | null =>
  proposalCall(call)?.action ?? null;

export type ProposalLine =
  | { key: string; kind: "draft"; draft: AutomationDraft }
  // a fork's copy of a call that proposed in the chat it came from
  | ({ key: string; kind: "inert" } & ProposalCall);

// a draft names the call's tool row; a fork copies rows under new ids
// and no drafts, so a copied row that proposed has none
export function proposalLines(
  node: ReplyNode,
  drafts: readonly AutomationDraft[],
  session: Pick<SessionSummary, "forkedFromId" | "createdAt">,
): ProposalLine[] {
  const byRow = new Map(drafts.map((draft) => [draft.messageId, draft]));
  const lines: ProposalLine[] = [];
  for (const round of node.work?.rounds ?? []) {
    for (const { key, call, result } of round.calls) {
      const proposed = proposalCall(call);
      if (proposed === null || result === null) continue;
      const draft = byRow.get(result.id);
      if (draft !== undefined) {
        lines.push({ key: `proposal:${key}`, kind: "draft", draft });
      } else if (
        session.forkedFromId !== null &&
        result.createdAt < session.createdAt &&
        result.status === "done"
      ) {
        lines.push({ key: `proposal:${key}`, kind: "inert", ...proposed });
      }
    }
  }
  return lines;
}

export const HEADS: Record<ProposalAction, { icon: IconName; title: string }> =
  {
    create: { icon: "clock", title: "New task" },
    update: { icon: "pencil", title: "Change" },
    suspend: { icon: "pause", title: "Suspend" },
    resume: { icon: "play", title: "Resume" },
    run: { icon: "bolt", title: "Run now" },
  };

const DONE: Record<ProposalAction, string> = {
  create: "Created",
  update: "Changed",
  suspend: "Suspended",
  resume: "Resumed",
  run: "Ran",
};

export const INERT_WORDS = "Proposed in the original chat";
// the name a line on a task gone, or not read, shows
export const GONE_NAME = "a deleted task";
export const UNREAD_NAME = "the task";

// how often "confirmed by @user, 40s ago" moves: every second while it
// counts seconds, then at the coarseness ago() shows
export function agoTickMs(at: number, now: number): number {
  const age = now - at;
  if (age < 60_000) return 1000;
  if (age < 3_600_000) return 30_000;
  return 300_000;
}

// the line's icon and action word, and what it says at its end once
// decided: who and when, or why it was not applied
export function lineHead(draft: AutomationDraft): {
  icon: IconName;
  title: string;
  by: { verb: string; username: string; at: number } | null;
  note: string | null;
} {
  const head = HEADS[draft.action];
  const by = (verb: string) =>
    draft.decidedBy === null
      ? null
      : {
          verb,
          username: draft.decidedBy.username,
          at: draft.decidedAt ?? draft.createdAt,
        };
  switch (draft.state) {
    case "pending":
      return { ...head, by: null, note: null };
    case "confirmed":
      return {
        icon: "check",
        title: DONE[draft.action],
        by: by("confirmed"),
        note: draft.decidedBy === null ? "confirmed" : null,
      };
    case "dismissed":
      return {
        ...head,
        by: by("dismissed"),
        note: draft.decidedBy === null ? "dismissed" : null,
      };
    case "stale":
      return { ...head, by: null, note: "not applied, the task changed" };
    case "expired":
      return { ...head, by: null, note: "not applied, expired" };
  }
}

// where the name links: the task a confirm made, the run it started,
// else the task named; null while there is none to link
export function nameTarget(
  draft: AutomationDraft,
  taskExists: boolean,
): { kind: "task" | "run"; id: string } | null {
  if (draft.state === "confirmed" && draft.action === "run") {
    if (draft.runSessionId !== null) {
      return { kind: "run", id: draft.runSessionId };
    }
  }
  if (draft.createdAutomationId !== null) {
    return { kind: "task", id: draft.createdAutomationId };
  }
  if (draft.automationId !== null && taskExists) {
    return { kind: "task", id: draft.automationId };
  }
  return null;
}

// the words the task page uses, else the expression as cron
export function when(schedule: string, once: boolean): string {
  if (once) return "once";
  return scheduleWords(schedule) === null
    ? schedule
    : scheduleTitle(schedule).toLowerCase();
}

const FIELD_WORDS: [keyof ProposalFields, string][] = [
  ["name", "name"],
  ["schedule", "schedule"],
  ["tz", "time zone"],
  ["once", "run once"],
  ["instructions", "instructions"],
  ["ownMemory", "memory"],
  ["memoryGuidance", "memory"],
  ["attentionGuidance", "attention"],
];

// what the line says after the name while it waits: when a new task
// runs, which fields an update changes
export function lineDetail(draft: AutomationDraft): string | null {
  if (draft.state !== "pending") return null;
  if (draft.action === "create") {
    return when(draft.fields.schedule, draft.fields.once);
  }
  if (draft.action === "update") {
    const fields = draft.fields;
    const words = FIELD_WORDS.filter(([key]) => fields[key] !== undefined).map(
      ([, words]) => words,
    );
    return [...new Set(words)].join(", ");
  }
  return null;
}

// a create opens to its instructions, an update to what it changes
export function opens(draft: AutomationDraft): boolean {
  return draft.action === "create" || draft.action === "update";
}

export type FieldRow = { label: string; value: string; was: string | null };

const yes = (on: boolean) => (on ? "yes" : "no");

// an update's changed fields beside the task's values, struck when
// they differ
export function changedFields(
  fields: Partial<ProposalFields>,
  before: Pick<
    ProposalFields,
    "name" | "schedule" | "tz" | "once" | "ownMemory"
  > | null,
): FieldRow[] {
  const rows: FieldRow[] = [];
  const was = (now: string, then: string | undefined) =>
    then === undefined || then === now ? null : then;
  if (fields.name !== undefined) {
    rows.push({
      label: "Name",
      value: fields.name,
      was: was(fields.name, before?.name),
    });
  }
  if (fields.schedule !== undefined) {
    const old = was(fields.schedule, before?.schedule);
    rows.push({
      label: "Schedule",
      value: when(fields.schedule, false),
      was: old === null ? null : when(old, false),
    });
  }
  if (fields.tz !== undefined) {
    rows.push({
      label: "Time zone",
      value: fields.tz,
      was: was(fields.tz, before?.tz),
    });
  }
  if (fields.once !== undefined) {
    rows.push({
      label: "Run once",
      value: yes(fields.once),
      was: was(
        yes(fields.once),
        before === null ? undefined : yes(before.once),
      ),
    });
  }
  if (fields.ownMemory !== undefined) {
    rows.push({
      label: "Own memory",
      value: yes(fields.ownMemory),
      was: was(
        yes(fields.ownMemory),
        before?.ownMemory === undefined ? undefined : yes(before.ownMemory),
      ),
    });
  }
  return rows;
}

export type TextBlock = {
  // null for the instructions, which need none
  label: string | null;
  value: string;
  // the task's text an update replaces; undefined for a create, or
  // while the task is not read
  was?: string;
};

// a create's texts under its instructions, each only when set
export function createTexts(
  fields: Pick<
    ProposalFields,
    "instructions" | "ownMemory" | "memoryGuidance" | "attentionGuidance"
  >,
): TextBlock[] {
  const texts: TextBlock[] = [{ label: null, value: fields.instructions }];
  if (fields.ownMemory && fields.memoryGuidance !== "") {
    texts.push({ label: "Memory", value: fields.memoryGuidance });
  }
  if (fields.attentionGuidance !== "") {
    texts.push({ label: "Attention", value: fields.attentionGuidance });
  }
  return texts;
}

// an update's changed texts beside the task's
export function updateTexts(
  fields: Partial<ProposalFields>,
  before: Pick<
    ProposalFields,
    "instructions" | "memoryGuidance" | "attentionGuidance"
  > | null,
): TextBlock[] {
  const texts: TextBlock[] = [];
  const keys = [
    ["instructions", null],
    ["memoryGuidance", "Memory"],
    ["attentionGuidance", "Attention"],
  ] as const;
  for (const [key, label] of keys) {
    const value = fields[key];
    if (value !== undefined) texts.push({ label, value, was: before?.[key] });
  }
  return texts;
}

// the lines an update changes; an empty side has no lines, so a
// guidance set or cleared draws no blank line
export function changedLines(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  if (before === "") {
    return after.split("\n").map((text) => ({ kind: "added", text }));
  }
  if (after === "") {
    return before.split("\n").map((text) => ({ kind: "removed", text }));
  }
  return lineDiff(before, after).filter((line) => line.kind !== "same");
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

// the old and new instructions line by line, by their longest common
// run; the lines both share at the ends are set aside first, so a small
// edit to a long text keeps the table small
export function lineDiff(before: string, after: string): DiffLine[] {
  const all = before.split("\n");
  const next = after.split("\n");
  let head = 0;
  while (head < all.length && head < next.length && all[head] === next[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < all.length - head &&
    tail < next.length - head &&
    all[all.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  const same = (lines: string[]): DiffLine[] =>
    lines.map((text) => ({ kind: "same", text }));
  return [
    ...same(all.slice(0, head)),
    ...lcsDiff(
      all.slice(head, all.length - tail),
      next.slice(head, next.length - tail),
    ),
    ...same(all.slice(all.length - tail)),
  ];
}

// past this many cells the middle is drawn as all removed, then all
// added: still every change, without a table that eats the tab
export const DIFF_CELLS = 1_000_000;

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > DIFF_CELLS) {
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i++] });
    } else out.push({ kind: "added", text: b[j++] });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });
  return out;
}

// format characters (bidi controls, zero-width, tags that smuggle
// ASCII), fillers that draw blank and the line separators: each
// changes what a reader sees without showing itself
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the joiner and the selectors are matched alone, to be shown.
  /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u2028\u2029\u{E0100}-\u{E01EF}]/gu;

export type TextPart = { mark: boolean; text: string };

// the text cut at each invisible character, drawn as its code point
// what an emoji is made of: a joiner between two pictographs (a family,
// a profession), and a subdivision flag's tag run after the black flag
const PICTURE_BEFORE =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?$/u;
const PICTURE_AFTER = /^\p{Extended_Pictographic}/u;
// only the three subdivision flags Unicode lists (England, Scotland,
// Wales): any other tag run, a flag's included, can carry hidden text
const FLAG_TAGS =
  /^\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/u;
const BLACK_FLAG = "\u{1F3F4}";

// how far an emoji's own invisible characters run from at; at when none
function emojiPart(text: string, at: number, mark: string): number {
  if (mark === "\u200D") {
    const before = PICTURE_BEFORE.test(text.slice(Math.max(0, at - 4), at));
    return before && PICTURE_AFTER.test(text.slice(at + 1, at + 3))
      ? at + 1
      : at;
  }
  if (text.slice(at - BLACK_FLAG.length, at) !== BLACK_FLAG) return at;
  const run = FLAG_TAGS.exec(text.slice(at, at + 2 * 6));
  return run === null ? at : at + run[0].length;
}

export function visibleParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  let skip = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    const at = m.index;
    if (at < skip) continue;
    skip = emojiPart(text, at, m[0]);
    if (skip > at) continue;
    if (at > last) parts.push({ mark: false, text: text.slice(last, at) });
    const code = m[0].codePointAt(0)?.toString(16).toUpperCase() ?? "";
    parts.push({ mark: true, text: `U+${code.padStart(4, "0")}` });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ mark: false, text: text.slice(last) });
  return parts;
}
