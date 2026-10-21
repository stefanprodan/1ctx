// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// External tasks on the page: the words of a row and an entry, the
// moves each state offers, the brief's checks and what an edit sends;
// and the entity: frames by the revision rule, a close that never comes
// back with a list read before it, Home's waiting rows, and the task's
// page, which names the state and the claim it shows.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { reload, startLoading } from "../../../src/client/app/loading.ts";
import { path, query } from "../../../src/client/app/router.ts";
import { match } from "../../../src/client/app/routes.ts";
import {
  deleteExternalTask,
  loadExternalTask,
  loadMoreEntries,
  moveExternalTask,
  onExternalTaskSocket,
  TASK_DELETED,
  taskError,
  taskPage,
  withFileFrame,
} from "../../../src/client/data/external-task.ts";
import {
  HELD_FILES,
  onTaskFilesSocket,
  openTaskFile,
  readsOnOpen,
  taskFileKey,
  taskFileRead,
  taskFiles,
} from "../../../src/client/data/external-task-files.ts";
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
  tasksTabHref,
} from "../../../src/client/data/external-tasks.ts";
import { TRAIL_MS } from "../../../src/client/data/flight.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  loadWaitingTasks,
  onWaitingSocket,
  waitingTasks,
} from "../../../src/client/data/waiting-tasks.ts";
import { externalTasksHref } from "../../../src/client/lib/hrefs.ts";
import {
  createAndLink,
  makeTaskFile,
} from "../../../src/client/views/projects/ExternalTaskNewFile.tsx";
import {
  chatName,
  claimDeadline,
  deadlineTime,
  draftOf,
  entryBy,
  fileLabel,
  GROUP_ROWS,
  groupsOf,
  labelIdsOf,
  labelNamesOf,
  movedWords,
  movesOf,
  NO_LABEL,
  patchOf,
  pickLabel,
  requestOf,
  rowLine,
  showOf,
  taskFieldOf,
  taskFilePath,
  tasksAddressOf,
  tasksSwitch,
  webLink,
  withFile,
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
import type { KnowledgeFile } from "../../../src/shared/contracts/knowledge.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { type ClaimEnd, MAX_TITLE } from "../../../src/shared/words.ts";

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
  claimLimit: false,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: 1_000,
  movedAt: 1_000,
  ...changes,
});

const detail = (
  changes: Partial<ExternalTaskDetail> = {},
): ExternalTaskDetail => ({
  task: row(),
  files: [
    {
      fileId: "f1",
      name: "plan.md",
      revision: 3,
      changedAt: 1,
      deleted: false,
    },
  ],
  briefAt: 1_000,
  chatId: null,
  chatTitle: null,
  createdKeyName: null,
  ...changes,
});

describe("the words", () => {
  test("a row's second line says who moved it last, per state", () => {
    const by = { id: "u2", username: "ana" };
    const last = (
      kind: NonNullable<ExternalTaskRow["last"]>["kind"],
      who: {
        by: typeof by | null;
        keyName: string | null;
        claimEnd?: ClaimEnd;
      },
      text = "",
    ): ExternalTaskRow["last"] => ({
      kind,
      text,
      at: 5,
      claimEnd: null,
      ...who,
    });
    // awaiting input: the question, on one line
    expect(
      rowLine(
        row({
          state: "awaiting_input",
          claim,
          last: last(
            "question",
            { by, keyName: "laptop" },
            "Which `branch`?\nmore",
          ),
        }),
      ),
    ).toBe("Which branch?");
    expect(rowLine(row({ state: "in_progress", claim }))).toBe(
      "Claimed by @stefan via laptop-claude",
    );
    // todo: who opened it, else who reopened or gave it back last
    expect(rowLine(row())).toBe("Opened by @stefan");
    expect(rowLine(row({ createdBy: null }))).toBe("Opened by a deleted user");
    expect(
      rowLine(row({ last: last("reopen", { by, keyName: null }, "again") })),
    ).toBe("Reopened by @ana");
    expect(
      rowLine(row({ last: last("unclaim", { by, keyName: "laptop" }) })),
    ).toBe("Unclaimed by @ana via laptop");
    // only 1ctx's own releases name it, with their reason
    expect(
      rowLine(
        row({
          last: last("unclaim", { by: null, keyName: null, claimEnd: "idle" }),
        }),
      ),
    ).toBe("Unclaimed by 1ctx, idle");
    expect(
      rowLine(
        row({
          last: last("unclaim", {
            by: null,
            keyName: null,
            claimEnd: "access_gone",
          }),
        }),
      ),
    ).toBe("Unclaimed by 1ctx, access gone");
    const stopped = last("unclaim", {
      by: null,
      keyName: null,
      claimEnd: "limit",
    });
    expect(rowLine(row({ last: stopped }))).toBe(
      "Unclaimed by 1ctx, limit reached",
    );
    // a todo task no agent may claim again says so, whoever moved it
    expect(rowLine(row({ last: stopped, claimLimit: true }))).toBe(
      "Claim limit reached",
    );
    expect(rowLine(row({ claimLimit: true }))).toBe("Claim limit reached");
    // a member since deleted is never 1ctx
    expect(
      rowLine(
        row({
          last: last("unclaim", {
            by: null,
            keyName: null,
            claimEnd: "unclaimed",
          }),
        }),
      ),
    ).toBe("Unclaimed by a deleted user");
    expect(
      rowLine(row({ last: last("reopen", { by: null, keyName: null }) })),
    ).toBe("Reopened by a deleted user");
    // a reopen not the latest entry says nothing of it
    expect(
      rowLine(row({ last: last("progress", { by, keyName: "laptop" }) })),
    ).toBe("Opened by @stefan");
    expect(
      rowLine(
        row({
          state: "done",
          last: last("result", { by, keyName: "laptop" }, "Shipped"),
        }),
      ),
    ).toBe("Done by @ana via laptop");
    expect(
      rowLine(
        row({ state: "canceled", last: last("cancel", { by, keyName: null }) }),
      ),
    ).toBe("Canceled by @ana");
    expect(
      rowLine(
        row({
          state: "canceled",
          last: last("cancel", { by: null, keyName: null }),
        }),
      ),
    ).toBe("Canceled by a deleted user");
  });

  test("the page's line says when the task last moved, never who", () => {
    expect(movedWords(row({ state: "awaiting_input" }))).toBe("Asked");
    expect(movedWords(row({ state: "in_progress" }))).toBe("Updated");
    expect(movedWords(row({ state: "done" }))).toBe("Done");
    expect(movedWords(row({ state: "canceled" }))).toBe("Canceled");
    expect(movedWords(row())).toBe("Opened");
    const at = { text: "", at: 1, by: null, keyName: null, claimEnd: null };
    expect(movedWords(row({ last: { kind: "reopen", ...at } }))).toBe(
      "Reopened",
    );
    expect(movedWords(row({ last: { kind: "unclaim", ...at } }))).toBe(
      "Unclaimed",
    );
  });

  test("the tab groups by whose turn it is, twenty rows a group", () => {
    const many = (state: ExternalTaskRow["state"], n: number) =>
      Array.from({ length: n }, (_, i) => row({ id: `${state}${i}`, state }));
    const rows = [
      ...many("todo", 3),
      ...many("in_progress", 45),
      ...many("awaiting_input", 1),
    ];
    const groups = groupsOf(rows, {});
    expect(groups.map((g) => g.label)).toEqual([
      "Awaiting input",
      "In progress",
      "Todo",
    ]);
    const progress = groups[1]!;
    expect(progress.total).toBe(45);
    expect(progress.rows).toHaveLength(GROUP_ROWS);
    expect(progress.more).toBe(true);
    expect(groups[2]!.more).toBe(false);
    // Show more adds twenty, then the rest
    expect(groupsOf(rows, { in_progress: 40 })[1]!.rows).toHaveLength(40);
    const all = groupsOf(rows, { in_progress: 60 })[1]!;
    expect(all.rows).toHaveLength(45);
    expect(all.more).toBe(false);
    // a state with no row has no group
    expect(groupsOf(many("todo", 2), {}).map((g) => g.state)).toEqual(["todo"]);
  });

  test("the tab's view and search are in the address", () => {
    const cases: [string, ReturnType<typeof tasksAddressOf>][] = [
      ["", { show: null, q: "" }],
      ["?show=done", { show: "done", q: "" }],
      ["?show=canceled&q=sweep", { show: "canceled", q: "sweep" }],
      ["?q=%20sweep%20", { show: null, q: "sweep" }],
      // an unknown view is Open, a blank search none
      ["?show=closed&q=", { show: null, q: "" }],
      ["?show=DONE", { show: null, q: "" }],
    ];
    for (const [search, want] of cases) {
      expect(tasksAddressOf(search), search).toEqual(want);
    }
    const tab = "/projects/p%201/external-tasks";
    expect(externalTasksHref("p 1")).toBe(tab);
    expect(externalTasksHref("p 1", "done")).toBe(`${tab}?show=done`);
    expect(externalTasksHref("p 1", null, " a b ")).toBe(`${tab}?q=a+b`);
    expect(externalTasksHref("p 1", "canceled", "x")).toBe(
      `${tab}?show=canceled&q=x`,
    );
    expect(externalTasksHref("p 1", null, "  ")).toBe(tab);
    // what one builds the other reads back
    expect(tasksAddressOf("?show=canceled&q=a+b")).toEqual({
      show: "canceled",
      q: "a b",
    });
  });

  test("the switch goes to each view, keeping the search", () => {
    const tab = "/projects/p1/external-tasks";
    expect(tasksSwitch("p1", "done", "sweep")).toEqual([
      { label: "Open", on: false, href: `${tab}?q=sweep` },
      { label: "Done", on: true, href: `${tab}?show=done&q=sweep` },
      { label: "Canceled", on: false, href: `${tab}?show=canceled&q=sweep` },
    ]);
    expect(tasksSwitch("p1", null, "").map((v) => [v.on, v.href])).toEqual([
      [true, tab],
      [false, `${tab}?show=done`],
      [false, `${tab}?show=canceled`],
    ]);
  });

  test("a task is listed on the view of its state", () => {
    expect(showOf("done")).toBe("done");
    expect(showOf("canceled")).toBe("canceled");
    for (const state of ["todo", "in_progress", "awaiting_input"] as const) {
      expect(showOf(state)).toBeNull();
    }
  });

  test("an entry names who wrote it", () => {
    const by = { id: "u1", username: "stefan" };
    const e = (
      changes: Partial<Pick<ExternalTaskEntry, "by" | "keyName" | "kind">> & {
        claimEnd?: ClaimEnd | null;
      },
    ) => ({
      kind: "answer" as ExternalTaskEntry["kind"],
      by: null,
      keyName: null,
      claimEnd: null,
      ...changes,
    });
    // 1ctx only on its own releases; any other entry with no user had one
    expect(entryBy(e({ kind: "unclaim", claimEnd: "idle" }))).toBe("1ctx");
    expect(entryBy(e({ kind: "unclaim", claimEnd: "access_gone" }))).toBe(
      "1ctx",
    );
    expect(entryBy(e({}))).toBe("a deleted user");
    expect(entryBy(e({ kind: "unclaim", claimEnd: "unclaimed" }))).toBe(
      "a deleted user",
    );
    expect(entryBy(e({ keyName: "laptop-claude" }))).toBe(
      "a deleted user via laptop-claude",
    );
    expect(entryBy(e({ by }))).toBe("@stefan");
    expect(entryBy(e({ by, keyName: "laptop-claude" }))).toBe(
      "@stefan via laptop-claude",
    );
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

  test("a task whose labels were all deleted sends no edit until it has one", () => {
    const bare = detail({ task: row({ labels: [] }) });
    // even a title alone is refused here, as the server would
    expect(requestOf({ ...draftOf(bare), title: "Renamed" })).toEqual({
      problem: NO_LABEL,
      field: "labels",
    });
    const picked = requestOf({ ...draftOf(bare), labels: ["fix"] });
    if (!("body" in picked)) throw new Error("refused");
    expect(patchOf(picked.body, bare, 2)).toEqual({
      editRevision: 2,
      labels: ["fix"],
    });
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
  chatId: null,
  chatTitle: null,
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

  // a server whose file f1 moves on with each write: a read answers the
  // file as it was when the read started, and while held a call waits
  // for release(), which answers the latest call first, so an older
  // read lands last
  const fileServer = () => {
    const state = {
      file: { name: "plan.md", revision: 3, updatedAt: 1, deleted: false },
      task: row(),
      reads: 0,
      held: false,
    };
    const gates: (() => void)[] = [];
    const linkOf = () => ({
      fileId: "f1",
      name: state.file.name,
      revision: state.file.deleted ? null : state.file.revision,
      changedAt: state.file.deleted ? null : state.file.updatedAt,
      deleted: state.file.deleted,
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ call: `${method} ${url}`, body: undefined });
      if (method === "POST" && url === "/api/external-tasks/t1/cancel") {
        state.task = {
          ...state.task,
          state: "canceled",
          revision: state.task.revision + 1,
        };
      }
      const page =
        url.startsWith("/api/external-tasks/t1") &&
        (method === "GET" || url.endsWith("/cancel"));
      if (method === "GET" && page) state.reads++;
      const answer: ExternalTaskResponse = {
        ...pageAnswer(state.task),
        task: detail({ task: state.task, files: [linkOf()] }),
      };
      if (state.held) await new Promise<void>((open) => gates.push(open));
      return page
        ? Response.json(answer)
        : Response.json({ error: "no" }, { status: 404 });
    }) as unknown as typeof fetch;
    // the write lands on the server, then its frame on the page
    const write = (changes: Partial<typeof state.file>) => {
      state.file = { ...state.file, ...changes };
      send({
        type: "knowledge",
        projectId: "p1",
        file: {
          id: "f1",
          projectId: "p1",
          name: state.file.name,
          kind: "md",
          bytes: 5,
          lines: 1,
          tokens: 2,
          revision: state.file.revision,
          author: {
            kind: "user",
            id: "u1",
            name: "stefan",
            sessionId: null,
            origin: null,
            keyName: null,
          },
          createdAt: 1,
          updatedAt: state.file.updatedAt,
        },
        deleted: state.file.deleted,
      });
    };
    const release = async () => {
      state.held = false;
      for (const open of gates.splice(0).toReversed()) {
        open();
        await flush();
      }
      // past the flight's pause, so a trailing read runs and lands
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(TRAIL_MS);
        await flush();
      }
    };
    return { state, write, release };
  };
  const linked = () => taskPage.value?.detail.files[0];
  // the flight's pause on a fake clock
  const faked = async (body: () => Promise<void>) => {
    jest.useFakeTimers();
    try {
      await body();
    } finally {
      jest.useRealTimers();
    }
  };
  const RENAMED = {
    fileId: "f1",
    name: "plans/new.md",
    revision: 4,
    changedAt: 5_000,
    deleted: false,
  };
  const rename = { name: "plans/new.md", revision: 4, updatedAt: 5_000 };

  test.serial(
    "a linked file's write patches its row at once, then reads the page",
    () =>
      faked(async () => {
        const server = fileServer();
        await loadExternalTask("t1");
        await server.release();
        const before = server.state.reads;
        server.write(rename);
        expect(linked()).toEqual(RENAMED);
        await server.release();
        expect(server.state.reads).toBe(before + 1);
        expect(linked()).toEqual(RENAMED);
        // an older frame, another file or another project leaves the page
        const held = taskPage.value!;
        for (const [id, projectId, revision] of [
          ["f2", "p1", 9],
          ["f1", "p2", 9],
          ["f1", "p1", 3],
        ] as const) {
          const frame = { id, projectId, name: "x.md", revision, updatedAt: 9 };
          expect(withFileFrame(held, frame as KnowledgeFile, false)).toBe(held);
        }
        server.write({ deleted: true });
        expect(linked()).toEqual({
          fileId: "f1",
          name: "plans/new.md",
          revision: null,
          changedAt: null,
          deleted: true,
        });
        await server.release();
        expect(linked()?.deleted).toBe(true);
      }),
  );

  test.serial(
    "a rename during a page read outlives the read's older answer",
    () =>
      faked(async () => {
        const server = fileServer();
        await loadExternalTask("t1");
        await server.release();
        server.state.held = true;
        const read = loadExternalTask("t1");
        server.write(rename);
        expect(linked()).toEqual(RENAMED);
        await server.release();
        await read;
        await server.release();
        expect(linked()).toEqual(RENAMED);
      }),
  );

  test.serial("a delete during a page read is never undone by its answer", () =>
    faked(async () => {
      const server = fileServer();
      await loadExternalTask("t1");
      await server.release();
      server.state.held = true;
      const read = loadExternalTask("t1");
      server.write({ deleted: true });
      expect(linked()?.deleted).toBe(true);
      await server.release();
      await read;
      await server.release();
      expect(linked()?.deleted).toBe(true);
      expect(linked()?.changedAt).toBeNull();
    }),
  );

  test.serial(
    "a write before the first read answers is read once it lands",
    () =>
      faked(async () => {
        const server = fileServer();
        server.state.held = true;
        const read = loadExternalTask("t1");
        expect(taskPage.value).toBeNull();
        server.write(rename);
        await server.release();
        await read;
        await server.release();
        expect(linked()).toEqual(RENAMED);
        // the read out, then one after the write
        expect(server.state.reads).toBe(2);
      }),
  );

  test.serial("a write during a member's move outlives the move's answer", () =>
    faked(async () => {
      const server = fileServer();
      await loadExternalTask("t1");
      await server.release();
      server.state.held = true;
      const move = moveExternalTask("t1", "cancel", { state: "todo" });
      server.write(rename);
      await server.release();
      await move;
      await server.release();
      expect(taskPage.value?.detail.task.state).toBe("canceled");
      expect(linked()).toEqual(RENAMED);
    }),
  );

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
    "the tab's route reads the closed page its address names",
    async () => {
      answer = (_method, url) =>
        url.includes("closed=1")
          ? Response.json({
              tasks: [row({ id: "d1", state: "done" })],
              next: null,
            })
          : url === "/api/projects/p1/external-tasks"
            ? Response.json(listAnswer([row()]))
            : Response.json({ error: "no" }, { status: 404 });
      const load = match("/projects/p1/external-tasks")!;
      const run = (search: string) =>
        load.route.load!(load.params, new URLSearchParams(search));
      const closedGets = () =>
        calls.filter((c) => c.call.includes("closed=1")).map((c) => c.call);
      // Open reads no closed page, whatever it searches
      await run("q=sweep");
      expect(closedGets()).toEqual([]);
      expect(externalTasks.value?.map((t) => t.id)).toEqual(["t1"]);
      await run("show=done&q=sweep");
      expect(closedGets()).toEqual([
        "GET /api/projects/p1/external-tasks?closed=1&q=sweep&state=done",
      ]);
      expect(closedFilter.value).toEqual({ q: "sweep", state: "done" });
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["d1"]);
      // back on the same view the pages held are drawn, not read again
      await run("show=done&q=sweep");
      expect(closedGets()).toHaveLength(1);
      await run("show=canceled");
      expect(closedGets()[1]).toBe(
        "GET /api/projects/p1/external-tasks?closed=1&state=canceled",
      );
      // another project reads its own
      const other = match("/projects/p2/external-tasks")!;
      await other.route.load!(other.params, new URLSearchParams("show=done"));
      expect(closedGets()[2]).toBe(
        "GET /api/projects/p2/external-tasks?closed=1&state=done",
      );
    },
  );

  test.serial(
    "a pick or a search on the tab reads only the closed page",
    async () => {
      answer = (_method, url) =>
        url.includes("closed=1")
          ? Response.json({ tasks: [], next: null })
          : url === "/api/projects/p1/external-tasks"
            ? Response.json(listAnswer([row()]))
            : Response.json({ error: "no" }, { status: 404 });
      const tab = "/projects/p1/external-tasks";
      const go = async (search: string) => {
        calls = [];
        query.value = search;
        await settle();
        return calls.map((c) => c.call);
      };
      path.value = tab;
      query.value = "";
      const stop = startLoading();
      try {
        await settle();
        // arriving is the whole load: the project, its lists, the week
        const arrival = calls.map((c) => c.call);
        expect(arrival).toContain("GET /api/projects/p1");
        expect(arrival).toContain("GET /api/projects/p1/external-tasks");
        expect(arrival).toHaveLength(6);
        // Open filters the list it holds, word by word
        for (const typed of ["?q=s", "?q=sw", "?q=sweep"]) {
          expect(await go(typed)).toEqual([]);
        }
        expect(await go("?show=done&q=sweep")).toEqual([
          "GET /api/projects/p1/external-tasks?closed=1&q=sweep&state=done",
        ]);
        expect(await go("?show=done&q=sweeps")).toEqual([
          "GET /api/projects/p1/external-tasks?closed=1&q=sweeps&state=done",
        ]);
        expect(await go("?q=sweeps")).toEqual([]);
        // the tab as left is where its pages lead back
        expect(tasksTabHref("p1", "done")).toBe(`${tab}?q=sweeps`);
        await go("?show=canceled&q=x");
        expect(tasksTabHref("p1")).toBe(`${tab}?show=canceled&q=x`);
        // reload is the whole load again, all but the rail's list
        calls = [];
        await reload();
        expect(calls.map((c) => c.call).sort()).toEqual(
          arrival.filter((c) => c !== "GET /api/projects").sort(),
        );
      } finally {
        stop();
        path.value = "/";
        query.value = "";
      }
    },
  );

  test.serial("with no tab left, its pages lead to the view given", () => {
    const tab = "/projects/p9/external-tasks";
    expect(tasksTabHref("p9")).toBe(tab);
    expect(tasksTabHref("p9", "canceled")).toBe(`${tab}?show=canceled`);
  });

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

describe("the form's files and labels", () => {
  const labelsOf = (...ids: string[]) =>
    ids.map((id) => ({ id, name: `label ${id}` }));

  test("a label picked joins once, at most three", () => {
    const all = labelsOf("l1", "l2", "a", "b", "c", "d");
    expect(pickLabel(["l1"], "l2", all)).toEqual(["l1", "l2"]);
    expect(pickLabel(["l1"], "l1", all)).toEqual(["l1"]);
    expect(pickLabel(["a", "b", "c"], "d", all)).toEqual(["a", "b", "c"]);
  });

  test("a label deleted since the form opened frees its place", () => {
    expect(pickLabel(["a", "b", "c"], "d", labelsOf("a", "b", "d"))).toEqual([
      "a",
      "b",
      "d",
    ]);
    expect(pickLabel(["a", "b", "c"], "d", labelsOf("d"))).toEqual(["d"]);
    // a label deleted before the pick lands is not picked
    expect(pickLabel(["a"], "d", labelsOf("a"))).toEqual(["a"]);
  });

  test("a new file's path is the title made a name under tasks/", () => {
    const cases: [string, string][] = [
      ["Wire the sweep", "tasks/wire-the-sweep.md"],
      ["  Fix   the  gaps  ", "tasks/fix-the-gaps.md"],
      ["Café déjà vu: Straße", "tasks/cafe-deja-vu-strasse.md"],
      ["Fix #12 & ship!!", "tasks/fix-12-ship.md"],
      ["Fix 日本 bug", "tasks/fix-bug.md"],
      ["../../etc/passwd", "tasks/etc-passwd.md"],
      ["a/b\\c", "tasks/a-b-c.md"],
      ["README.md", "tasks/readme.md"],
      ["...hidden", "tasks/hidden.md"],
      // nothing left to name it by
      ["", ""],
      ["   ", ""],
      ["日本語", ""],
      ["..", ""],
      ["!?#", ""],
    ];
    for (const [title, path] of cases) expect(taskFilePath(title)).toBe(path);
    // a path the draft already links, the file just made, takes a number
    expect(taskFilePath("Wire it", ["tasks/wire-it.md"])).toBe(
      "tasks/wire-it-2.md",
    );
    expect(
      taskFilePath("Wire it", ["tasks/wire-it.md", "tasks/wire-it-2.md"]),
    ).toBe("tasks/wire-it-3.md");
    expect(taskFilePath("Wire it", ["plan.md"])).toBe("tasks/wire-it.md");
    // within the name's room, the number kept
    const long = taskFilePath("x".repeat(80));
    const next = taskFilePath("x".repeat(80), [long]);
    expect(next).toBe(`tasks/${"x".repeat(75)}-2.md`);
    // a long title is cut to fit a name's 80 characters with its .md
    for (const title of ["x".repeat(80), "ß".repeat(79), "a-".repeat(40)]) {
      const path = taskFilePath(title);
      const name = path.slice("tasks/".length);
      expect(name.length).toBeLessThanOrEqual(80);
      expect(name).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]\.md$/);
    }
  });

  test("a file joins once, at most five", () => {
    const draft = { title: "", labels: [], fileIds: ["f1"] };
    expect(withFile(draft, "f2").fileIds).toEqual(["f1", "f2"]);
    expect(withFile(draft, "f1")).toBe(draft);
    const full = { ...draft, fileIds: ["1", "2", "3", "4", "5"] };
    expect(withFile(full, "6")).toBe(full);
  });

  test.serial(
    "New file makes the file through the knowledge route and links it",
    async () => {
      answer = (method, url) =>
        method === "POST" && url === "/api/projects/p1/knowledge"
          ? Response.json(
              {
                file: {
                  id: "f9",
                  projectId: "p1",
                  name: "briefs/sweep.md",
                  kind: "md",
                  bytes: 5,
                  lines: 1,
                  tokens: 2,
                  revision: 1,
                  author: null,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
              { status: 201 },
            )
          : Response.json({ error: "no" }, { status: 404 });
      const id = await makeTaskFile("p1", " briefs/sweep.md ", "# Plan");
      expect(calls).toEqual([
        {
          call: "POST /api/projects/p1/knowledge",
          body: { name: "briefs/sweep.md", text: "# Plan" },
        },
      ]);
      const draft = { title: "Sweep", labels: ["build"], fileIds: ["f1"] };
      const linked = withFile(draft, id);
      expect(linked.fileIds).toEqual(["f1", "f9"]);
      expect(requestOf(linked)).toEqual({
        body: { title: "Sweep", labels: ["build"], fileIds: ["f1", "f9"] },
      });
    },
  );

  test.serial("a file opened in place is read once per revision", async () => {
    answer = () =>
      Response.json({
        file: { text: "# Plan", html: '<h1 class="md-h1">Plan</h1>' },
      });
    await openTaskFile("p1", "f1", 3);
    await openTaskFile("p1", "f1", 3);
    expect(calls.map((c) => c.call)).toEqual([
      "GET /api/projects/p1/knowledge/files/f1",
    ]);
    expect(taskFileRead("f1", 3)).toEqual({
      state: "done",
      html: '<h1 class="md-h1">Plan</h1>',
      text: "# Plan",
    });
    // a file written since is read again
    await openTaskFile("p1", "f1", 4);
    expect(calls).toHaveLength(2);
  });

  test.serial(
    "a failed file read is read again when its row opens",
    async () => {
      let fail = true;
      answer = () =>
        fail
          ? Response.json({ error: "busy" }, { status: 503 })
          : Response.json({ file: { text: "x", html: null } });
      expect(readsOnOpen(taskFileRead("f1", 7))).toBe(true);
      await openTaskFile("p1", "f1", 7);
      expect(taskFileRead("f1", 7)?.state).toBe("failed");
      expect(readsOnOpen(taskFileRead("f1", 7))).toBe(true);
      fail = false;
      await openTaskFile("p1", "f1", 7);
      expect(taskFileRead("f1", 7)?.state).toBe("done");
      expect(readsOnOpen(taskFileRead("f1", 7))).toBe(false);
      expect(readsOnOpen({ state: "loading" })).toBe(false);
    },
  );

  test.serial("the files opened in place stay bounded", async () => {
    answer = () => Response.json({ file: { text: "x", html: null } });
    for (let i = 0; i < HELD_FILES + 4; i++) {
      await openTaskFile("p1", `f${i}`, 1);
    }
    expect(taskFiles.value.size).toBe(HELD_FILES);
    // the least recent went first
    expect(taskFiles.value.has(taskFileKey("f0", 1))).toBe(false);
    expect(taskFiles.value.has(taskFileKey(`f${HELD_FILES + 3}`, 1))).toBe(
      true,
    );
  });

  test("labels are held by id, so renames and reused names stay right", () => {
    const opened = detail({ task: row({ labels: ["build"] }) });
    const before = [
      { id: "l1", name: "build" },
      { id: "l2", name: "fix" },
    ];
    const ids = labelIdsOf(draftOf(opened).labels, before);
    expect(ids).toEqual(["l1"]);
    // build is renamed backend, then a new label takes the name build
    const after = [
      { id: "l1", name: "backend" },
      { id: "l2", name: "fix" },
      { id: "l3", name: "build" },
    ];
    expect(labelNamesOf(ids, after)).toEqual(["backend"]);
    // picking the new build picks it, never the old one
    const picked = pickLabel(ids, "l3", after);
    expect(labelNamesOf(picked, after)).toEqual(["backend", "build"]);
    // a title-only save sends no stale name
    const live = {
      ...draftOf(opened),
      title: "Renamed",
      labels: labelNamesOf(ids, after),
    };
    const request = requestOf(live);
    if (!("body" in request)) throw new Error("refused");
    const now = detail({ task: row({ labels: ["backend"], title: "Wire" }) });
    expect(patchOf(request.body, now, 1)).toEqual({
      editRevision: 1,
      title: "Renamed",
    });
    // a deleted label leaves the picks
    expect(labelNamesOf(["l1", "l2"], [after[1]!])).toEqual(["fix"]);
    expect(labelIdsOf(["gone"], before)).toEqual([]);
  });

  test.serial(
    "a knowledge frame for an opened file drops it, a read out lands nowhere",
    async () => {
      answer = () => Response.json({ file: { text: "old", html: null } });
      await openTaskFile("p1", "f1", 3);
      await openTaskFile("p1", "f2", 1);
      expect(taskFileRead("f1", 3)?.state).toBe("done");
      onTaskFilesSocket({
        type: "knowledge",
        projectId: "p1",
        deleted: false,
        file: { id: "f1" } as KnowledgeFile,
      });
      expect(taskFileRead("f1", 3)).toBeUndefined();
      expect(taskFileRead("f2", 1)?.state).toBe("done");
      // a read started before a write keeps nothing
      hold = true;
      const read = openTaskFile("p1", "f1", 3);
      onTaskFilesSocket({
        type: "knowledge",
        projectId: "p1",
        deleted: true,
        file: { id: "f1" } as KnowledgeFile,
      });
      await unclaim();
      await read;
      expect(taskFileRead("f1", 3)).toBeUndefined();
    },
  );

  test.serial(
    "a revoked project drops its files, a read out lands nowhere",
    async () => {
      answer = () => Response.json({ file: { text: "x", html: null } });
      await openTaskFile("p1", "f1", 1);
      await openTaskFile("p2", "f9", 1);
      hold = true;
      const read = openTaskFile("p1", "f2", 1);
      onTaskFilesSocket({ type: "revoked", projectId: "p1" });
      await unclaim();
      await read;
      expect(taskFileRead("f1", 1)).toBeUndefined();
      expect(taskFileRead("f2", 1)).toBeUndefined();
      expect(taskFileRead("f9", 1)?.state).toBe("done");
    },
  );

  test("the form hears a file is being made until it is linked", async () => {
    const said: string[] = [];
    let made: (id: string) => void = () => {};
    const done = createAndLink(
      () =>
        new Promise<string>((resolve) => {
          made = resolve;
        }),
      {
        creating: (busy) => said.push(busy ? "creating" : "idle"),
        created: (id) => said.push(`linked ${id}`),
      },
    );
    // the task cannot save while the file is out
    expect(said).toEqual(["creating"]);
    made("f9");
    await done;
    expect(said).toEqual(["creating", "linked f9", "idle"]);
    // a refused create frees the form with nothing linked
    const failed: string[] = [];
    await createAndLink(() => Promise.reject(new Error("taken")), {
      creating: (busy) => failed.push(busy ? "creating" : "idle"),
      created: (id) => failed.push(`linked ${id}`),
    }).catch(() => {});
    expect(failed).toEqual(["creating", "idle"]);
  });
});
