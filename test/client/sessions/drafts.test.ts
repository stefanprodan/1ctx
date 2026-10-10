// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { effect } from "@preact/signals";
import { me } from "../../../src/client/data/me.ts";
import {
  applyDraftFrame,
  decideDraft,
  draftsShown,
  draftTask,
  loadDraftTask,
  TASK_RETRY_MS,
  taskFailing,
} from "../../../src/client/data/session-drafts.ts";
import {
  leaveSession,
  loadSession,
  onSocket,
  session,
} from "../../../src/client/data/sessions.ts";
import type { AutomationDraft } from "../../../src/shared/contracts/automation-draft.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { hasWatchedDrafts } from "../../../src/shared/socket.ts";
import {
  createDraft,
  detail,
  proposalRows,
  task,
  taskDraft,
} from "../../fixtures/sessions/drafts.ts";

const realFetch = globalThis.fetch;

const states = () =>
  session.value?.automationDrafts.map((d) => [d.id, d.state]) ?? [];

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  } as typeof me.value;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  leaveSession();
});

const decided = (draft: AutomationDraft): AutomationDraft => ({
  ...draft,
  state: "confirmed",
  decidedBy: { id: "u2", username: "robin" },
  decidedAt: 2_000,
  createdAutomationId: "task-new",
});

describe("the draft frame", () => {
  test.serial(
    "adds a new draft, replaces a changed one, drops a removed one",
    () => {
      session.value = detail([createDraft()]);
      applyDraftFrame({
        type: "draft",
        sessionId: "chat-1",
        draft: taskDraft("run"),
      });
      expect(states()).toEqual([
        ["draft-1", "pending"],
        ["draft-run", "pending"],
      ]);
      applyDraftFrame({
        type: "draft",
        sessionId: "chat-1",
        draft: decided(createDraft()),
      });
      expect(session.value?.automationDrafts[0].createdAutomationId).toBe(
        "task-new",
      );
      applyDraftFrame({
        type: "draft",
        sessionId: "chat-1",
        draftId: "draft-run",
        removed: true,
      });
      expect(states()).toEqual([["draft-1", "confirmed"]]);
    },
  );

  test.serial("never puts a decided draft back to pending", () => {
    session.value = detail([decided(createDraft())]);
    applyDraftFrame({
      type: "draft",
      sessionId: "chat-1",
      draft: createDraft(),
    });
    expect(states()).toEqual([["draft-1", "confirmed"]]);
    const shown = draftsShown(detail([createDraft()]), session.value);
    expect(shown.automationDrafts[0].state).toBe("confirmed");
  });

  test.serial("leaves another chat alone", () => {
    session.value = detail([createDraft()]);
    applyDraftFrame({
      type: "draft",
      sessionId: "chat-2",
      draft: decided(createDraft()),
    });
    expect(states()).toEqual([["draft-1", "pending"]]);
  });
});

describe("a press", () => {
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      Response.json(body, { status })) as unknown as typeof fetch;
  };

  test.serial("lands the answer's state with the presser", async () => {
    session.value = detail([createDraft()]);
    answer(200, { state: "dismissed" });
    await decideDraft("draft-1", "dismiss");
    const [draft] = session.value?.automationDrafts ?? [];
    expect(draft.state).toBe("dismissed");
    expect(draft.decidedBy).toEqual({ id: "u1", username: "casey" });
  });

  test.serial("a refusal that decided it lands that state", async () => {
    session.value = detail([createDraft()]);
    answer(409, { state: "stale", error: "name is taken" });
    await decideDraft("draft-1", "confirm");
    expect(states()).toEqual([["draft-1", "stale"]]);
    expect(session.value?.automationDrafts[0].decidedBy).toBeNull();
  });

  test.serial("a refusal that leaves it pending throws its words", async () => {
    session.value = detail([taskDraft("run")]);
    answer(409, { state: "pending", error: "too many runs at once" });
    await expect(decideDraft("draft-run", "confirm")).rejects.toThrow(
      "too many runs at once",
    );
    expect(states()).toEqual([["draft-run", "pending"]]);
  });
});

describe("a reload", () => {
  test.serial(
    "keeps a draft a frame added while it was in flight",
    async () => {
      const base: SessionDetail = {
        ...detail([], { revision: 5, status: "running" }),
        messages: proposalRows([
          { id: "c1", args: { action: "run", id: "task-1" } },
        ]),
      };
      globalThis.fetch = (async () =>
        Response.json(base)) as unknown as typeof fetch;
      await loadSession("chat-1");
      let release: (body: unknown) => void = () => {};
      globalThis.fetch = (() =>
        new Promise<Response>((resolve) => {
          release = (body) => resolve(Response.json(body));
        })) as unknown as typeof fetch;
      const reload = loadSession("chat-1");
      onSocket({
        type: "draft",
        sessionId: "chat-1",
        draft: createDraft({ messageId: "tool-c1" }),
      });
      release(base);
      await reload;
      expect(states()).toEqual([["draft-1", "pending"]]);
      // a regenerate took the row, and its draft goes with it
      globalThis.fetch = (async () =>
        Response.json({ ...base, messages: [] })) as unknown as typeof fetch;
      await loadSession("chat-1");
      expect(states()).toEqual([]);
    },
  );
});

describe("a watch's answer", () => {
  test.serial("shows a draft it alone carries", async () => {
    globalThis.fetch = (async () =>
      Response.json(detail([]))) as unknown as typeof fetch;
    await loadSession("chat-1");
    onSocket({
      type: "watched",
      sessionId: "chat-1",
      live: null,
      drafts: [taskDraft("run")],
    });
    expect(states()).toEqual([["draft-run", "pending"]]);
  });

  test.serial("skips a draft of another shape and keeps the rest", async () => {
    globalThis.fetch = (async () =>
      Response.json(detail([]))) as unknown as typeof fetch;
    await loadSession("chat-1");
    const { rerunOnRestart: _, ...older } = createDraft().fields as Record<
      string,
      unknown
    >;
    const event = JSON.parse(
      JSON.stringify({
        type: "watched",
        sessionId: "chat-1",
        live: null,
        drafts: [{ ...createDraft(), fields: older }, taskDraft("run")],
      }),
    );
    expect(hasWatchedDrafts(event)).toBe(true);
    onSocket(event);
    expect(states()).toEqual([["draft-run", "pending"]]);
  });
});

describe("a 409 for a draft decided elsewhere", () => {
  test.serial("lands its state with no decider", async () => {
    session.value = detail([createDraft()]);
    globalThis.fetch = (async () =>
      Response.json(
        { state: "confirmed", error: "the proposal is confirmed" },
        { status: 409 },
      )) as unknown as typeof fetch;
    await decideDraft("draft-1", "dismiss");
    const [draft] = session.value?.automationDrafts ?? [];
    expect(draft.state).toBe("confirmed");
    expect(draft.decidedBy).toBeNull();
  });

  test.serial("an answer without a state word is a plain failure", async () => {
    session.value = detail([createDraft()]);
    globalThis.fetch = (async () =>
      Response.json(
        { state: "gone", error: "something else" },
        { status: 409 },
      )) as unknown as typeof fetch;
    await expect(decideDraft("draft-1", "confirm")).rejects.toThrow(
      "something else",
    );
    expect(states()).toEqual([["draft-1", "pending"]]);
  });
});

describe("the task a line names", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test.serial("only a 404 means gone; another failure asks again", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "no" },
        { status: 404 },
      )) as unknown as typeof fetch;
    await loadDraftTask("gone-1");
    expect(draftTask("gone-1")).toBeNull();
    expect(taskFailing("gone-1")).toBe(false);

    globalThis.fetch = (async () =>
      Response.json(
        { error: "down" },
        { status: 500 },
      )) as unknown as typeof fetch;
    jest.useFakeTimers();
    try {
      await loadDraftTask("flaky-1");
      // drawn while failing, so its buttons stay reachable, never as gone
      expect(draftTask("flaky-1")).toBeNull();
      expect(taskFailing("flaky-1")).toBe(true);
      let draws = 0;
      const stop = effect(() => {
        draftTask("flaky-1");
        draws++;
      });
      let reads = 0;
      globalThis.fetch = (async () => {
        reads++;
        return Response.json({ automation: task({ id: "flaky-1" }) });
      }) as unknown as typeof fetch;
      // within the pause nothing is asked
      await loadDraftTask("flaky-1");
      expect(reads).toBe(0);
      jest.advanceTimersByTime(TASK_RETRY_MS);
      // the timer alone draws the line again, whose effect reads once more
      expect(draws).toBe(2);
      stop();
      await loadDraftTask("flaky-1");
      expect(reads).toBe(1);
      expect(draftTask("flaky-1")?.name).toBe("nightly-check");
      expect(taskFailing("flaky-1")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test.serial("a deleted task reads as gone without a read", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        automation: task({ id: "task-9" }),
      })) as unknown as typeof fetch;
    await loadDraftTask("task-9");
    expect(draftTask("task-9")?.id).toBe("task-9");
    onSocket({
      type: "automationDeleted",
      automationId: "task-9",
      projectId: "p1",
      runs: false,
    });
    await settle();
    expect(draftTask("task-9")).toBeNull();
  });
});
