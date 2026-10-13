// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// External tasks on the page: the words of a row and an entry, the
// moves each state offers, the brief's checks and what an edit sends;
// and the entity: frames by the revision rule, a close that never comes
// back with a list read before it, Home's waiting rows, and the task's
// page, which names the state and the claim it shows.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  deleteExternalTask,
  loadExternalTask,
  loadMoreEntries,
  moveExternalTask,
  onExternalTaskSocket,
  TASK_DELETED,
  taskError,
  taskPage,
} from "../../../src/client/data/external-task.ts";
import {
  closedCount,
  closedFilter,
  closedPages,
  externalTaskCount,
  externalTasks,
  filterClosed,
  loadClosedTasks,
  loadExternalTasks,
  loadMoreClosed,
  onExternalTasksSocket,
} from "../../../src/client/data/external-tasks.ts";
import { TRAIL_MS } from "../../../src/client/data/flight.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  loadWaitingTasks,
  onWaitingSocket,
  waitingTasks,
} from "../../../src/client/data/waiting-tasks.ts";
import {
  chatName,
  claimDeadline,
  claimWords,
  deadlineTime,
  draftOf,
  entryBy,
  fileLabel,
  lastLine,
  movesOf,
  patchOf,
  requestOf,
  rowLine,
  stateLine,
  taskFieldOf,
  taskIcon,
  webLink,
} from "../../../src/client/views/projects/ExternalTasks.model.ts";
import type {
  ExternalTaskResponse,
  ExternalTasksResponse,
} from "../../../src/shared/api/external-tasks.ts";
import {
  type ExternalTaskDetail,
  type ExternalTaskEntry,
  type ExternalTaskRow,
  MAX_TASK_FILES,
} from "../../../src/shared/contracts/external-task.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { MAX_TITLE } from "../../../src/shared/words.ts";

const claim = {
  id: "c1",
  userId: "u1",
  username: "stefan",
  keyId: "k1",
  keyName: "laptop-claude",
  startedAt: 2_000,
  activeAt: 2_000,
};

// the projects Home's reads cover
const HOME = ["p1", "p9"];

const row = (changes: Partial<ExternalTaskRow> = {}): ExternalTaskRow => ({
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  labels: ["build"],
  state: "todo",
  revision: 1,
  editRevision: 0,
  claim: null,
  last: null,
  entries: 0,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: 1_000,
  movedAt: 1_000,
  ...changes,
});

const detail = (
  changes: Partial<ExternalTaskDetail> = {},
): ExternalTaskDetail => ({
  task: row(),
  files: [{ fileId: "f1", name: "plan.md", revision: 3, deleted: false }],
  briefAt: 1_000,
  chatId: null,
  chatTitle: null,
  ...changes,
});

describe("the words", () => {
  test("a claim names its user and key", () => {
    expect(claimWords(claim)).toBe("claimed by stefan via laptop-claude");
    expect(stateLine(row({ state: "in_progress", claim }))).toBe(
      "claimed by stefan via laptop-claude",
    );
    expect(stateLine(row({ state: "awaiting_input", claim }))).toBe(
      "awaiting input · claimed by stefan via laptop-claude",
    );
    expect(stateLine(row({ state: "done" }))).toBe("done");
    expect(stateLine(row({ state: "todo" }))).toBe("todo");
  });

  test("a row names only a claim, the icon says the rest", () => {
    expect(rowLine(row({ state: "awaiting_input", claim }))).toBe(
      "awaiting input · claimed by stefan via laptop-claude",
    );
    expect(rowLine(row({ state: "in_progress", claim }))).toBe(
      "claimed by stefan via laptop-claude",
    );
    for (const state of ["todo", "done", "canceled"] as const) {
      expect(rowLine(row({ state }))).toBe("");
    }
  });

  test("an entry names who wrote it", () => {
    const by = { id: "u1", username: "stefan" };
    expect(entryBy({ by: null, keyName: null })).toBe("1ctx");
    expect(entryBy({ by: null, keyName: "laptop-claude" })).toBe(
      "a deleted user via laptop-claude",
    );
    expect(entryBy({ by, keyName: null })).toBe("@stefan");
    expect(entryBy({ by, keyName: "laptop-claude" })).toBe(
      "@stefan via laptop-claude",
    );
  });

  test("the last line is the latest entry on one line", () => {
    // no line at all before the first entry
    expect(lastLine(row())).toBeNull();
    expect(
      lastLine(
        row({
          last: {
            kind: "question",
            text: "Which\nbranch?",
            at: 1,
            by: null,
            keyName: null,
          },
        }),
      ),
    ).toBe("Question: Which branch?");
    expect(
      lastLine(
        row({
          last: { kind: "cancel", text: "", at: 1, by: null, keyName: null },
        }),
      ),
    ).toBe("Canceled");
  });

  test("a deleted file is marked, by its name while history has it", () => {
    expect(fileLabel({ name: "plan.md", deleted: false })).toBe("plan.md");
    expect(fileLabel({ name: "plan.md", deleted: true })).toBe(
      "deleted: plan.md",
    );
    expect(fileLabel({ name: null, deleted: true })).toBe("a deleted file");
  });

  test("only a web address is drawn as a link", () => {
    expect(webLink("https://github.com/o/r/pull/1")).toBe(true);
    expect(webLink("http://example.test/a")).toBe(true);
    expect(webLink("javascript:alert(1)")).toBe(false);
    expect(webLink("data:text/html,x")).toBe(false);
    expect(webLink("not a url")).toBe(false);
  });

  test("a claim's deadline is its last activity plus the idle limit, only while claimed", () => {
    const hour = 3_600_000;
    const claimed = row({ state: "in_progress", claim });
    expect(claimDeadline(claimed, 24)).toBe(2_000 + 24 * hour);
    expect(claimDeadline(claimed, 1)).toBe(2_000 + hour);
    // a report moves it on
    expect(
      claimDeadline({ ...claimed, claim: { ...claim, activeAt: 9_000 } }, 24),
    ).toBe(9_000 + 24 * hour);
    for (const state of [
      "todo",
      "awaiting_input",
      "done",
      "canceled",
    ] as const) {
      expect(
        claimDeadline(
          row({ state, claim: state === "awaiting_input" ? claim : null }),
          24,
        ),
      ).toBeNull();
    }
  });

  test("a claim ends at a time today, else on a date as Created reads", () => {
    const now = new Date(2026, 9, 12, 9, 0).getTime();
    expect(deadlineTime(new Date(2026, 9, 12, 22, 1).getTime(), now)).toBe(
      "22:01",
    );
    expect(deadlineTime(new Date(2026, 9, 13, 8, 0).getTime(), now)).toBe(
      "13 October 2026, 08:00",
    );
  });

  test("an untitled chat has a name", () => {
    expect(chatName("Plan the sweep")).toBe("Plan the sweep");
    expect(chatName("")).toBe("Untitled chat");
    // a title the server cut mid word drops the half word
    const line = "Create a task with the external task tool. ".repeat(3);
    const cut = `${line.slice(0, MAX_TITLE - 1)}…`;
    expect(cut.length).toBe(MAX_TITLE);
    expect(chatName(cut)).toBe(`${cut.slice(0, cut.lastIndexOf(" "))}…`);
    const unbroken = `${"x".repeat(MAX_TITLE - 1)}…`;
    expect(chatName(unbroken)).toBe(unbroken);
    // a cut that ended on a space was trimmed to MAX_TITLE - 1: whole
    const whole = `${"word ".repeat(15)}abc…`;
    expect(whole.length).toBe(MAX_TITLE - 1);
    expect(chatName(whole)).toBe(whole);
    // a short title ending in … was written so
    expect(chatName("What if we…")).toBe("What if we…");
  });

  test("only a task awaiting input takes the attention colour", () => {
    expect(taskIcon(row({ state: "in_progress" })).status).toBe("running");
    expect(taskIcon(row({ state: "done" })).status).toBe("done");
    expect(taskIcon(row({ state: "awaiting_input" }))).toEqual({
      name: "question",
      status: "attention",
    });
    expect(taskIcon(row({ state: "canceled" })).name).toBe("cancelled");
  });

  test("a todo task waits for a claim, never a clock", () => {
    expect(taskIcon(row())).toEqual({ name: "task-open", status: null });
  });
});

describe("the moves", () => {
  test("each state offers what a member may do", () => {
    expect(movesOf("todo")).toEqual({
      edit: true,
      answer: false,
      unclaim: false,
      cancel: true,
      reopen: false,
    });
    expect(movesOf("awaiting_input")).toEqual({
      edit: true,
      answer: true,
      unclaim: true,
      cancel: true,
      reopen: false,
    });
    expect(movesOf("in_progress").unclaim).toBe(true);
    expect(movesOf("done")).toEqual({
      edit: false,
      answer: false,
      unclaim: false,
      cancel: false,
      reopen: true,
    });
    expect(movesOf("canceled").reopen).toBe(true);
  });
});

describe("the brief's form", () => {
  const draft = { title: "Sweep", labels: ["build"], fileIds: ["f1"] };

  test("a title is required and one line, labels and files are required", () => {
    expect(requestOf({ ...draft, title: " " })).toEqual({
      problem: "a title is required",
      field: "title",
    });
    expect(requestOf({ ...draft, title: "a\nb" })).toMatchObject({
      field: "title",
    });
    expect(requestOf({ ...draft, title: "x".repeat(81) })).toMatchObject({
      field: "title",
    });
    expect(requestOf({ ...draft, labels: [] })).toMatchObject({
      field: "labels",
    });
    expect(requestOf({ ...draft, labels: ["a", "b", "c", "d"] })).toMatchObject(
      { field: "labels" },
    );
    expect(requestOf({ ...draft, fileIds: [] })).toMatchObject({
      field: "files",
    });
    expect(
      requestOf({
        ...draft,
        fileIds: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `f${i}`),
      }),
    ).toMatchObject({ field: "files" });
  });

  test("a title is sent trimmed", () => {
    expect(requestOf({ ...draft, title: " Sweep " })).toEqual({
      body: { title: "Sweep", labels: ["build"], fileIds: ["f1"] },
    });
  });

  test("an edit sends only what changed, and the revision it opened on", () => {
    const opened = detail();
    const body = { ...draftOf(opened), labels: ["build", "fix"] };
    const request = requestOf(body);
    if (!("body" in request)) throw new Error("refused");
    expect(patchOf(request.body, opened, 4)).toEqual({
      editRevision: 4,
      labels: ["build", "fix"],
    });
    const relinked = requestOf({ ...draftOf(opened), fileIds: ["f2"] });
    if (!("body" in relinked)) throw new Error("refused");
    expect(patchOf(relinked.body, opened, 4)).toEqual({
      editRevision: 4,
      fileIds: ["f2"],
    });
  });

  test("a server refusal finds its field", () => {
    expect(taskFieldOf("a title is one line")).toBe("title");
    expect(
      taskFieldOf("labels must name 1 to 3 distinct labels of the project"),
    ).toBe("labels");
    expect(taskFieldOf("choose 1 to 5 distinct files")).toBe("files");
    expect(taskFieldOf("changed since you opened it")).toBeUndefined();
  });
});

const realFetch = globalThis.fetch;
let calls: { call: string; body: unknown }[] = [];
let answer: (method: string, url: string) => Response;
let user = 0;
// while set, every call waits for unclaim()
let hold = false;
let gates: (() => void)[] = [];

const unclaim = async () => {
  hold = false;
  for (const open of gates.splice(0)) open();
  await settle();
  await settle();
};

const gets = (path: string) =>
  calls.filter((c) => c.call === `GET ${path}`).length;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// a settle under fake timers, where a zero timeout never fires alone
const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

// the held calls answered, with the flight's pause on a fake clock
const unclaimFaked = async () => {
  hold = false;
  for (const open of gates.splice(0)) open();
  await flush();
};

const listAnswer = (tasks: ExternalTaskRow[]): ExternalTasksResponse => ({
  tasks,
  closed: 2,
  idleHours: 24,
});

const pageAnswer = (task: ExternalTaskRow): ExternalTaskResponse => ({
  task: detail({ task }),
  entries: [],
  next: null,
  idleHours: 24,
});

const entryOf = (
  id: string,
  kind: ExternalTaskEntry["kind"] = "progress",
): ExternalTaskEntry => ({
  id,
  kind,
  text: id,
  links: [],
  by: null,
  keyName: null,
  claimId: null,
  claimEnd: null,
  at: 1_000,
});

const frame = (task: ExternalTaskRow): SocketEvent => ({
  type: "externalTask",
  projectId: task.projectId,
  task,
});

// a frame to every handler, in the order the modules register
const send = (ev: SocketEvent) => {
  onExternalTasksSocket(ev);
  onExternalTaskSocket(ev);
  onWaitingSocket(ev);
};

beforeEach(() => {
  // a new user each test, so nothing held carries over
  user++;
  me.value = {
    id: `u${user}`,
    username: "stefan",
    fullName: "Stefan",
    role: "member",
    mustChangePassword: false,
  };
  calls = [];
  hold = false;
  gates = [];
  answer = () => Response.json({ error: "no" }, { status: 404 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      call: `${method} ${url}`,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (hold) await new Promise<void>((open) => gates.push(open));
    return answer(method, url);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
});

describe("the entity", () => {
  test.serial(
    "the list loads whole and frames move it by revision",
    async () => {
      answer = () =>
        Response.json(
          listAnswer([
            row({ id: "a", revision: 2 }),
            row({ id: "b", state: "awaiting_input", revision: 1 }),
          ]),
        );
      await loadExternalTasks("p1");
      expect(externalTasks.value?.map((t) => t.id)).toEqual(["b", "a"]);
      expect(externalTaskCount("p1")).toBe(2);
      expect(externalTaskCount("p2")).toBeNull();
      // an older frame changes nothing, a newer one moves the row
      send(frame(row({ id: "a", revision: 1, title: "old" })));
      expect(externalTasks.value?.find((t) => t.id === "a")?.title).toBe(
        "Wire the sweep",
      );
      send(frame(row({ id: "a", revision: 3, state: "done", entries: 1 })));
      expect(externalTasks.value?.map((t) => t.id)).toEqual(["b"]);
      expect(closedCount.value).toBe(3);
      send({
        type: "externalTaskDeleted",
        projectId: "p1",
        taskId: "b",
      });
      expect(externalTasks.value).toEqual([]);
    },
  );

  test.serial("a list read before a close never brings it back", async () => {
    answer = () => Response.json(listAnswer([row({ id: "a", revision: 1 })]));
    await loadExternalTasks("p1");
    let unclaim: () => void = () => {};
    answer = () => Response.json(listAnswer([row({ id: "a", revision: 1 })]));
    const realAnswer = answer;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      await new Promise<void>((resolve) => {
        unclaim = resolve;
      });
      return realAnswer(init?.method ?? "GET", url);
    }) as unknown as typeof fetch;
    const load = loadExternalTasks("p1");
    send(frame(row({ id: "a", revision: 2, state: "canceled", entries: 1 })));
    unclaim();
    await load;
    expect(externalTasks.value).toEqual([]);
  });

  test.serial("Home's waiting rows follow the frames", async () => {
    const waits = { state: "awaiting_input", claim } as const;
    answer = () =>
      Response.json({
        tasks: [row({ id: "a", ...waits, movedAt: 20 })],
        count: 1,
        projectIds: HOME,
      });
    await loadWaitingTasks();
    expect(waitingTasks.value?.tasks.map((t) => t.id)).toEqual(["a"]);
    onWaitingSocket(
      frame(
        row({ id: "b", projectId: "p9", ...waits, movedAt: 10, revision: 2 }),
      ),
    );
    // the oldest question first
    expect(waitingTasks.value?.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    // a project the read did not cover, an admin's other team, stays off
    onWaitingSocket(
      frame(row({ id: "c", projectId: "p8", ...waits, revision: 2 })),
    );
    expect(waitingTasks.value?.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    // an answer moves it on and off the card
    onWaitingSocket(
      frame(row({ id: "a", state: "in_progress", claim, revision: 2 })),
    );
    expect(waitingTasks.value).toEqual({
      tasks: [
        row({ id: "b", projectId: "p9", ...waits, movedAt: 10, revision: 2 }),
      ],
      count: 1,
    });
    onWaitingSocket({
      type: "externalTaskDeleted",
      projectId: "p9",
      taskId: "b",
    });
    expect(waitingTasks.value).toEqual({ tasks: [], count: 0 });
  });

  test.serial(
    "a label renamed or deleted reads the tab, the page and Home again",
    async () => {
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row()))
          : url === "/api/external-tasks?waiting=1"
            ? Response.json({ tasks: [], count: 0, projectIds: HOME })
            : Response.json(listAnswer([row()]));
      await loadExternalTasks("p1");
      await loadExternalTask("t1");
      await loadWaitingTasks();
      calls = [];
      // no row moved, so the reads answer the new names at the same revision
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row({ labels: ["bug"] })))
          : url === "/api/external-tasks?waiting=1"
            ? Response.json({ tasks: [], count: 0, projectIds: HOME })
            : Response.json(listAnswer([row({ labels: ["bug"] })]));
      send({ type: "projectLabels", projectId: "p1" });
      await settle();
      await settle();
      expect(calls.map((c) => c.call).sort()).toEqual([
        "GET /api/external-tasks/t1",
        "GET /api/external-tasks?waiting=1",
        "GET /api/projects/p1/external-tasks",
      ]);
      expect(externalTasks.value?.[0]?.labels).toEqual(["bug"]);
      expect(taskPage.value?.detail.task.labels).toEqual(["bug"]);
      // another project's labels read nothing here
      calls = [];
      send({ type: "projectLabels", projectId: "p5" });
      await settle();
      expect(calls).toEqual([]);
    },
  );

  test.serial(
    "a label renamed while the first reads are out reads each again",
    async () => {
      // answers read before the rename carry the old name
      let renamed = false;
      const labels = () => (renamed ? ["bug"] : ["fix"]);
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row({ labels: labels() })))
          : url === "/api/external-tasks?waiting=1"
            ? Response.json({ tasks: [], count: 0, projectIds: HOME })
            : url.includes("closed=1")
              ? Response.json({
                  tasks: [row({ id: "d", state: "done", labels: labels() })],
                  next: null,
                })
              : Response.json(listAnswer([row({ labels: labels() })]));
      jest.useFakeTimers();
      try {
        hold = true;
        const loads = [
          loadExternalTasks("p1"),
          loadExternalTask("t1"),
          loadWaitingTasks(),
        ];
        send({ type: "projectLabels", projectId: "p1" });
        await unclaimFaked();
        await Promise.all(loads);
        hold = true;
        const closed = loadClosedTasks("p1");
        send({ type: "projectLabels", projectId: "p1" });
        await unclaimFaked();
        await closed;
        renamed = true;
        expect(externalTasks.value?.[0]?.labels).toEqual(["fix"]);
        jest.advanceTimersByTime(TRAIL_MS);
        await flush();
        // the second rename, during the closed page, asks the held list
        // and page once more too
        expect(gets("/api/projects/p1/external-tasks")).toBe(3);
        expect(gets("/api/external-tasks/t1")).toBe(3);
        expect(gets("/api/projects/p1/external-tasks?closed=1")).toBe(2);
        expect(gets("/api/external-tasks?waiting=1")).toBe(2);
        expect(externalTasks.value?.[0]?.labels).toEqual(["bug"]);
        expect(closedPages.value?.rows[0]?.labels).toEqual(["bug"]);
        expect(taskPage.value?.detail.task.labels).toEqual(["bug"]);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test.serial("an unclaim names the state and the claim shown", async () => {
    const held = row({ state: "in_progress", claim, revision: 4 });
    answer = () =>
      Response.json(pageAnswer({ ...held, state: "todo", claim: null }));
    await moveExternalTask("t1", "unclaim", {
      state: "in_progress",
      claimId: "c1",
      text: "wrong plan",
    });
    expect(calls).toEqual([
      {
        call: "POST /api/external-tasks/t1/unclaim",
        body: { state: "in_progress", claimId: "c1", text: "wrong plan" },
      },
    ]);
  });

  test.serial("a frame with a new entry reads the page again", async () => {
    answer = (_method, url) =>
      url === "/api/external-tasks/t1"
        ? Response.json(pageAnswer(row({ revision: 1 })))
        : Response.json({ error: "no" }, { status: 404 });
    await loadExternalTask("t1");
    calls = [];
    send(frame(row({ revision: 2, entries: 1 })));
    await settle();
    expect(calls.map((c) => c.call)).toContain("GET /api/external-tasks/t1");
    // an already seen entry count moves the row and reads nothing
    calls = [];
    send(frame(row({ revision: 9, entries: 1 })));
    await settle();
    expect(calls).toEqual([]);
    expect(taskPage.value?.detail.task.revision).toBe(9);
  });

  test.serial("a deleted task's page says so", async () => {
    answer = (_method, url) =>
      url === "/api/external-tasks/t1"
        ? Response.json(pageAnswer(row()))
        : Response.json({ error: "no" }, { status: 404 });
    await loadExternalTask("t1");
    send({
      type: "externalTaskDeleted",
      projectId: "p1",
      taskId: "t1",
    });
    expect(taskPage.value).toBeNull();
    expect(taskError.value).toBe(TASK_DELETED);
  });

  test.serial("a member's own delete is counted once", async () => {
    answer = (_method, url) =>
      url === "/api/projects/p1/external-tasks"
        ? Response.json(listAnswer([row({ id: "t1" })]))
        : url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row({ id: "t1" })))
          : Response.json({ error: "no" }, { status: 404 });
    await loadExternalTasks("p1");
    await loadExternalTask("t1");
    answer = () => new Response(null, { status: 204 });
    await deleteExternalTask("t1");
    send({ type: "externalTaskDeleted", projectId: "p1", taskId: "t1" });
    expect(externalTasks.value).toEqual([]);
    expect(closedCount.value).toBe(2);
  });

  test.serial("a first visit answered under a frame reads again", async () => {
    answer = (_method, url) =>
      url === "/api/external-tasks/t1"
        ? Response.json(pageAnswer(row({ revision: 1 })))
        : Response.json({ error: "no" }, { status: 404 });
    hold = true;
    const load = loadExternalTask("t1");
    send(frame(row({ revision: 5, state: "in_progress", claim })));
    await unclaim();
    await load;
    await settle();
    expect(gets("/api/external-tasks/t1")).toBe(2);
  });

  test.serial(
    "frames before the first list neither stack loads nor lose a close",
    async () => {
      answer = () => Response.json(listAnswer([row({ id: "a" })]));
      hold = true;
      const load = loadExternalTasks("p1");
      send(frame(row({ id: "a", revision: 2, state: "in_progress", claim })));
      send(frame(row({ id: "b", revision: 1 })));
      expect(gets("/api/projects/p1/external-tasks")).toBe(1);
      await unclaim();
      await load;
      // the answer may predate the frames: one trailing read settles it
      expect(gets("/api/projects/p1/external-tasks")).toBe(2);
      expect(externalTasks.value).not.toBeNull();
    },
  );

  test.serial("a close during a list read asks once more", async () => {
    answer = () => Response.json(listAnswer([row({ id: "a" })]));
    await loadExternalTasks("p1");
    hold = true;
    const load = loadExternalTasks("p1");
    send(frame(row({ id: "a", revision: 2, state: "done", entries: 1 })));
    expect(closedCount.value).toBe(3);
    await unclaim();
    await load;
    expect(gets("/api/projects/p1/external-tasks")).toBe(3);
  });

  test.serial(
    "a close during the first closed page asks it again",
    async () => {
      answer = (_method, url) =>
        url.includes("closed=1")
          ? Response.json({ tasks: [], next: null })
          : Response.json(listAnswer([row({ id: "a" })]));
      await loadExternalTasks("p1");
      jest.useFakeTimers();
      try {
        hold = true;
        const load = loadClosedTasks("p1");
        send(frame(row({ id: "a", revision: 2, state: "done", entries: 1 })));
        await unclaimFaked();
        await load;
        expect(gets("/api/projects/p1/external-tasks?closed=1")).toBe(1);
        // the flight's pause, then the page again
        jest.advanceTimersByTime(TRAIL_MS);
        await flush();
        expect(gets("/api/projects/p1/external-tasks?closed=1")).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test.serial(
    "a closed search and state go to the server, a later page keeps them",
    async () => {
      answer = (_method, url) =>
        url.includes("closed=1")
          ? Response.json({
              tasks: [
                row({
                  id: url.includes("after=") ? "d2" : "d1",
                  state: "done",
                }),
              ],
              next: url.includes("after=") ? null : "5.abcdefghijkl",
            })
          : Response.json(listAnswer([]));
      await loadExternalTasks("p1");
      await loadClosedTasks("p1");
      expect(gets("/api/projects/p1/external-tasks?closed=1")).toBe(1);
      await filterClosed({ q: " sweep ", state: "done" });
      expect(
        gets("/api/projects/p1/external-tasks?closed=1&q=sweep&state=done"),
      ).toBe(1);
      // the box's text stays as typed; the same words read nothing
      await filterClosed({ q: "sweep", state: "done" });
      expect(closedFilter.value.q).toBe("sweep");
      expect(
        gets("/api/projects/p1/external-tasks?closed=1&q=sweep&state=done"),
      ).toBe(1);
      await loadMoreClosed();
      expect(
        gets(
          "/api/projects/p1/external-tasks?closed=1&q=sweep&state=done&after=5.abcdefghijkl",
        ),
      ).toBe(1);
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["d1", "d2"]);
      expect(closedPages.value?.next).toBeNull();
      // another project starts from every finished task
      await loadExternalTasks("p2");
      expect(closedFilter.value).toEqual({ q: "", state: null });
    },
  );

  test.serial(
    "an answer to an older search never lands over a newer one",
    async () => {
      const waiting: (() => void)[] = [];
      answer = (_method, url) =>
        url.includes("closed=1")
          ? Response.json({
              tasks: [
                row({
                  id: url.includes("q=old") ? "old" : "new",
                  state: "canceled",
                }),
              ],
              next: null,
            })
          : Response.json(listAnswer([]));
      await loadExternalTasks("p1");
      const realAnswer = answer;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        // the older search answers last
        if (url.includes("q=old")) {
          await new Promise<void>((open) => waiting.push(open));
        }
        return realAnswer(init?.method ?? "GET", url);
      }) as unknown as typeof fetch;
      const older = filterClosed({ q: "old", state: null });
      expect(closedPages.value).toBeNull();
      await filterClosed({ q: "new", state: null });
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["new"]);
      for (const open of waiting) open();
      await older;
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["new"]);
      // a frame the filter does not take stays off the pages
      send(
        frame(row({ id: "x", title: "other", state: "canceled", revision: 2 })),
      );
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["new"]);
    },
  );

  test.serial(
    "Home's frames during its read land over the answer",
    async () => {
      answer = () =>
        Response.json({
          tasks: [
            row({
              id: "a",
              state: "awaiting_input",
              claim,
              movedAt: 10,
              revision: 1,
            }),
          ],
          count: 1,
          projectIds: HOME,
        });
      hold = true;
      const load = loadWaitingTasks();
      send(
        frame(
          row({
            id: "b",
            state: "awaiting_input",
            claim,
            movedAt: 20,
            revision: 2,
          }),
        ),
      );
      send(frame(row({ id: "a", revision: 2 })));
      await unclaim();
      await load;
      expect(waitingTasks.value?.tasks.map((t) => t.id)).toEqual(["b"]);
      expect(waitingTasks.value?.count).toBe(1);
    },
  );

  test.serial(
    "Home keeps a frame from a project the read out is adding",
    async () => {
      answer = () => Response.json({ tasks: [], count: 0, projectIds: ["p1"] });
      await loadWaitingTasks();
      answer = () =>
        Response.json({ tasks: [], count: 0, projectIds: ["p1", "p7"] });
      hold = true;
      const load = loadWaitingTasks();
      send(
        frame(
          row({
            id: "n",
            projectId: "p7",
            state: "awaiting_input",
            claim,
            movedAt: 20,
          }),
        ),
      );
      await unclaim();
      await load;
      expect(waitingTasks.value?.tasks.map((t) => t.id)).toEqual(["n"]);
    },
  );

  test.serial(
    "Home's first read drops what it saw from projects it does not cover",
    async () => {
      answer = () => Response.json({ tasks: [], count: 0, projectIds: ["p1"] });
      hold = true;
      const load = loadWaitingTasks();
      send(
        frame(
          row({
            id: "x",
            projectId: "p8",
            state: "awaiting_input",
            claim,
            movedAt: 20,
          }),
        ),
      );
      await unclaim();
      await load;
      expect(waitingTasks.value?.tasks).toEqual([]);
    },
  );

  test.serial("Home reads again once cleared rows thin the card", async () => {
    answer = () =>
      Response.json({
        tasks: [row({ id: "a", state: "awaiting_input", claim, movedAt: 10 })],
        count: 60,
        projectIds: HOME,
      });
    await loadWaitingTasks();
    send(frame(row({ id: "a", revision: 2 })));
    await settle();
    expect(gets("/api/external-tasks?waiting=1")).toBe(2);
  });

  test.serial(
    "a read a newer frame overtook still lands its entries",
    async () => {
      const question = entryOf("q1", "question");
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row({ revision: 1 })))
          : Response.json({ error: "no" }, { status: 404 });
      await loadExternalTask("t1");
      answer = () =>
        Response.json({
          ...pageAnswer(
            row({ revision: 2, entries: 1, state: "awaiting_input", claim }),
          ),
          entries: [question],
        });
      hold = true;
      // the question's frame asks for the page; a newer frame overtakes it
      send(
        frame(row({ revision: 2, entries: 1, state: "awaiting_input", claim })),
      );
      send(
        frame(
          row({
            revision: 3,
            entries: 1,
            state: "awaiting_input",
            claim,
          }),
        ),
      );
      await unclaim();
      expect(taskPage.value?.entries.map((e) => e.id)).toEqual(["q1"]);
      expect(taskPage.value?.detail.task.revision).toBe(3);
    },
  );

  test.serial(
    "a later page asked before the timeline started over is dropped",
    async () => {
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json({
              ...pageAnswer(row({ revision: 1, entries: 3 })),
              entries: [entryOf("e3"), entryOf("e2")],
              next: "e2",
            })
          : Response.json({ error: "no" }, { status: 404 });
      await loadExternalTask("t1");
      answer = (_method, url) =>
        url.includes("before=")
          ? Response.json({
              ...pageAnswer(row({ revision: 1, entries: 3 })),
              entries: [entryOf("e1")],
              next: null,
            })
          : Response.json({
              ...pageAnswer(row({ revision: 9, entries: 60 })),
              entries: [entryOf("e60"), entryOf("e59")],
              next: "e59",
            });
      hold = true;
      const more = loadMoreEntries();
      send(frame(row({ revision: 9, entries: 60 })));
      const [moreGate, refreshGate] = gates.splice(0);
      hold = false;
      refreshGate();
      await settle();
      await settle();
      moreGate();
      await more;
      expect(taskPage.value?.next).toBe("e59");
      expect(taskPage.value?.entries.map((e) => e.id)).toEqual(["e60", "e59"]);
      expect(taskPage.value?.more.loading).toBe(false);
    },
  );

  test.serial(
    "a revoke drops a read out and every page held of it",
    async () => {
      answer = (_method, url) =>
        url === "/api/external-tasks/t2"
          ? Response.json(pageAnswer(row({ id: "t2" })))
          : url === "/api/external-tasks/t1"
            ? Response.json(pageAnswer(row()))
            : Response.json({ error: "no" }, { status: 404 });
      await loadExternalTask("t2");
      hold = true;
      const load = loadExternalTask("t1");
      send({ type: "revoked", projectId: "p1" });
      await unclaim();
      await load;
      expect(taskPage.value).toBeNull();
      expect(taskError.value).toBe("You no longer see this project.");
      // the held page of the project is gone too, never drawn again
      hold = true;
      const again = loadExternalTask("t2");
      expect(taskPage.value).toBeNull();
      await unclaim();
      await again;
    },
  );

  test.serial("Home's frames past 50 rows read the count again", async () => {
    const waits = { state: "awaiting_input", claim } as const;
    // oldest question first, as the server answers
    const fifty = Array.from({ length: 50 }, (_, i) =>
      row({ id: `a${String(i).padStart(2, "0")}`, ...waits, movedAt: 100 + i }),
    );
    answer = () => Response.json({ tasks: fifty, count: 60, projectIds: HOME });
    jest.useFakeTimers();
    try {
      hold = true;
      const load = loadWaitingTasks();
      // a frame during the read, sorting past the rows held
      send(frame(row({ id: "b", ...waits, movedAt: 500, revision: 2 })));
      await unclaimFaked();
      await load;
      expect(gets("/api/external-tasks?waiting=1")).toBe(1);
      // the flight's pause, then the count again
      jest.advanceTimersByTime(TRAIL_MS);
      await flush();
      expect(gets("/api/external-tasks?waiting=1")).toBe(2);
      // a frame once read, past the rows held, may be counted already
      send(frame(row({ id: "c", ...waits, movedAt: 600, revision: 2 })));
      await flush();
      jest.advanceTimersByTime(TRAIL_MS);
      await flush();
      expect(gets("/api/external-tasks?waiting=1")).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test.serial(
    "Home reads the count again after a delete past its rows",
    async () => {
      const fifty = Array.from({ length: 50 }, (_, i) =>
        row({ id: `a${i}`, state: "awaiting_input", claim, movedAt: 100 - i }),
      );
      answer = () =>
        Response.json({ tasks: fifty, count: 60, projectIds: HOME });
      await loadWaitingTasks();
      send({ type: "externalTaskDeleted", projectId: "p1", taskId: "zz" });
      await settle();
      expect(gets("/api/external-tasks?waiting=1")).toBe(2);
    },
  );

  test.serial(
    "a read started after a revoke clears it, with no grant",
    async () => {
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row()))
          : Response.json({ error: "no" }, { status: 404 });
      // the member was removed, then added again while the socket was down
      send({ type: "revoked", projectId: "p1" });
      await loadExternalTask("t1");
      expect(taskError.value).toBeNull();
      expect(taskPage.value?.id).toBe("t1");
      // and their own move lands on the page
      answer = () =>
        Response.json(pageAnswer(row({ revision: 2, state: "canceled" })));
      await moveExternalTask("t1", "cancel", { state: "todo" });
      expect(taskPage.value?.detail.task.state).toBe("canceled");
    },
  );
});
