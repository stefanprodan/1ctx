// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task proposals of the chat on screen: the detail's drafts, moved
// by the draft frame and by a press's answer, and the tasks they name,
// read once per id for the line's name and an update's old values. A
// draft never goes back to pending once decided, whichever of a frame,
// an answer or a detail lands last.

import { effect, signal } from "@preact/signals";
import type {
  AutomationResponse,
  DraftDecisionResponse,
} from "../../shared/api/automations.ts";
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import {
  type AutomationDraft,
  type DraftState,
  isAutomationDraft,
} from "../../shared/contracts/automation-draft.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { DraftFrame, SocketEvent } from "../../shared/socket.ts";
import { ApiError, api } from "./api.ts";
import { me } from "./me.ts";
import { session } from "./session-held.ts";

const settled = (draft: AutomationDraft | undefined) =>
  draft !== undefined && draft.state !== "pending";

// a detail's drafts over the ones held for the same chat, as children
// merge their rows: a frame newer than the read keeps its draft while
// the read still holds its tool row, which a regenerate takes with it
export function draftsShown(
  next: SessionDetail,
  held: SessionDetail | null,
): SessionDetail {
  if (held === null || held.session.id !== next.session.id) return next;
  const before = new Map(held.automationDrafts.map((d) => [d.id, d]));
  const ids = new Set(next.automationDrafts.map((d) => d.id));
  const rows = new Set(next.messages.map((m) => m.id));
  return {
    ...next,
    automationDrafts: [
      ...next.automationDrafts.map((draft) => {
        const old = before.get(draft.id);
        return draft.state === "pending" && settled(old) ? old! : draft;
      }),
      ...held.automationDrafts.filter(
        (d) => !ids.has(d.id) && rows.has(d.messageId),
      ),
    ],
  };
}

function replace(
  sessionId: string,
  change: (drafts: AutomationDraft[]) => AutomationDraft[],
): void {
  const held = session.value;
  if (held === null || held.session.id !== sessionId) return;
  session.value = { ...held, automationDrafts: change(held.automationDrafts) };
}

export function applyDraftFrame(frame: DraftFrame): void {
  replace(frame.sessionId, (drafts) => {
    if ("removed" in frame) return drafts.filter((d) => d.id !== frame.draftId);
    const next = frame.draft;
    const old = drafts.find((d) => d.id === next.id);
    if (old === undefined) return [...drafts, next];
    if (next.state === "pending" && settled(old)) return drafts;
    return drafts.map((d) => (d.id === next.id ? next : d));
  });
}

// a draft frame, or a watch's answer: each of its drafts that reads as
// one, any other skipped
export function onDraftSocket(
  ev: DraftFrame | Extract<SocketEvent, { type: "watched" }>,
): void {
  if (ev.type === "draft") {
    applyDraftFrame(ev);
    return;
  }
  for (const draft of ev.drafts ?? []) {
    if (isAutomationDraft(draft)) {
      applyDraftFrame({ type: "draft", sessionId: ev.sessionId, draft });
    }
  }
}

// a press's answer, before its frame; only a 200 was the presser's own
// decision, a 409 names one made elsewhere, whose frame says by whom
function answered(
  sessionId: string,
  id: string,
  state: DraftState,
  mine: boolean,
): void {
  if (state === "pending") return;
  const user = me.value;
  replace(sessionId, (drafts) =>
    drafts.map((d) => {
      if (d.id !== id || settled(d)) return d;
      return {
        ...d,
        state,
        decidedBy:
          mine && user && (state === "confirmed" || state === "dismissed")
            ? { id: user.id, username: user.username }
            : null,
        decidedAt: Date.now(),
      };
    }),
  );
}

const STATES: readonly string[] = [
  "pending",
  "confirmed",
  "dismissed",
  "stale",
  "expired",
] satisfies DraftState[];

const decisionOf = (body: unknown): DraftState | null => {
  const state =
    typeof body === "object" && body !== null
      ? (body as { state?: unknown }).state
      : undefined;
  return typeof state === "string" && STATES.includes(state)
    ? (state as DraftState)
    : null;
};

// a refusal that leaves the draft pending (a full run cap) throws its
// words; one that decided it (stale, expired, decided elsewhere) lands
// as that state
export async function decideDraft(
  id: string,
  action: "confirm" | "dismiss",
): Promise<void> {
  const sessionId = session.value?.session.id;
  if (sessionId === undefined) return;
  let state: DraftState;
  let mine = true;
  try {
    ({ state } = await api<DraftDecisionResponse>(
      `/api/automation-drafts/${encodeURIComponent(id)}/${action}`,
      "POST",
    ));
  } catch (err) {
    const refused =
      err instanceof ApiError && err.status === 409
        ? decisionOf(err.body)
        : null;
    if (refused === null || refused === "pending") throw err;
    state = refused;
    mine = false;
  }
  answered(sessionId, id, state, mine);
}

// a failed read other than a 404 or 403 is no answer: the line draws
// as for a gone task, and the read is asked again after a pause
export const TASK_RETRY_MS = 30_000;

const tasks = signal<ReadonlyMap<string, AutomationSummary | null>>(new Map());
// the ids whose last read failed, drawn as gone until a read answers;
// due once the pause is over, so the next draw asks again
const failing = signal<ReadonlySet<string>>(new Set());
const due = new Set<string>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
const asked = new Set<string>();
let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  asked.clear();
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
  due.clear();
  failing.value = new Set();
  tasks.value = new Map();
});

const keep = (id: string, task: AutomationSummary | null) => {
  tasks.value = new Map(tasks.value).set(id, task);
};

function failed(id: string): void {
  due.delete(id);
  failing.value = new Set(failing.value).add(id);
  retries.set(
    id,
    setTimeout(() => {
      retries.delete(id);
      due.add(id);
      // a new set draws the lines again, and their effect reads once more
      failing.value = new Set(failing.value);
    }, TASK_RETRY_MS),
  );
}

function settledRead(id: string): void {
  due.delete(id);
  if (!failing.value.has(id)) return;
  const next = new Set(failing.value);
  next.delete(id);
  failing.value = next;
}

// a failed read is not a gone task: the line names neither
export const taskFailing = (id: string): boolean => failing.value.has(id);

// undefined until read, null for a task gone, not seen or failing
export const draftTask = (id: string): AutomationSummary | null | undefined =>
  tasks.value.has(id)
    ? tasks.value.get(id)
    : failing.value.has(id)
      ? null
      : undefined;

export async function loadDraftTask(id: string): Promise<void> {
  const forUser = owner;
  if (asked.has(id) || tasks.value.has(id)) return;
  if (failing.value.has(id) && !due.has(id)) return;
  asked.add(id);
  try {
    const { automation } = await api<AutomationResponse>(
      `/api/automations/${encodeURIComponent(id)}`,
    );
    // a delete frame that came first wins over the read
    if (owner !== forUser) return;
    settledRead(id);
    if (tasks.value.get(id) === null) return;
    keep(id, automation);
  } catch (err) {
    if (owner !== forUser) return;
    const gone =
      err instanceof ApiError && (err.status === 404 || err.status === 403);
    if (gone) {
      settledRead(id);
      keep(id, null);
    } else failed(id);
  } finally {
    if (owner === forUser) asked.delete(id);
  }
}

// a deleted task's lines say so without a read
export function forgetTask(id: string): void {
  const retry = retries.get(id);
  if (retry !== undefined) clearTimeout(retry);
  retries.delete(id);
  settledRead(id);
  keep(id, null);
}
