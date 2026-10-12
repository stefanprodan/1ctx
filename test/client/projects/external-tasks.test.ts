// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// External tasks on the page: the words of a row and an entry, the
// moves each state offers, the brief's checks and what an edit sends;
// and the entity: frames by the revision rule, a close that never comes
// back with a list read before it, Home's marked rows, and the task's
// page, which clears its mark with seen and names the state and the
// claim it shows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deleteExternalTask,
  loadExternalTask,
  loadMoreEntries,
  markSeen,
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
import {
  loadMarkedTasks,
  markedTasks,
  onMarkedSocket,
} from "../../../src/client/data/marked-tasks.ts";
import { me } from "../../../src/client/data/me.ts";
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
  scope: null,
  state: "open",
  revision: 1,
  editRevision: 0,
  claim: null,
  last: null,
  entries: 0,
  attentionAt: null,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: 1_000,
  movedAt: 1_000,
  ...changes,
});

const detail = (
  changes: Partial<ExternalTaskDetail> = {},
): ExternalTaskDetail => ({
  task: row(),
  text: "Do the thing",
  files: [{ fileId: "f1", name: "plan.md", revision: 3, deleted: false }],
  briefAt: 1_000,
  chatId: null,
  chatTitle: null,
  ...changes,
});

describe("the words", () => {
  test("a claim names its user and key", () => {
    expect(claimWords(claim)).toBe("claimed by stefan via laptop-claude");
    expect(stateLine(row({ state: "claimed", claim }))).toBe(
      "claimed by stefan via laptop-claude",
    );
    expect(stateLine(row({ state: "blocked", claim }))).toBe(
      "blocked · claimed by stefan via laptop-claude",
    );
    expect(stateLine(row({ state: "done" }))).toBe("done");
  });

  test("a row names only a claim, the icon says the rest", () => {
    expect(rowLine(row({ state: "blocked", claim }))).toBe(
      "blocked · claimed by stefan via laptop-claude",
    );
    expect(rowLine(row({ state: "claimed", claim }))).toBe(
      "claimed by stefan via laptop-claude",
    );
    for (const state of ["open", "done", "cancelled"] as const) {
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
        row({ last: { kind: "question", text: "Which\nbranch?", at: 1 } }),
      ),
    ).toBe("Question: Which branch?");
    expect(lastLine(row({ last: { kind: "cancel", text: "", at: 1 } }))).toBe(
      "Cancelled",
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
    const claimed = row({ state: "claimed", claim });
    expect(claimDeadline(claimed, 24)).toBe(2_000 + 24 * hour);
    expect(claimDeadline(claimed, 1)).toBe(2_000 + hour);
    // a report moves it on
    expect(
      claimDeadline({ ...claimed, claim: { ...claim, activeAt: 9_000 } }, 24),
    ).toBe(9_000 + 24 * hour);
    for (const state of ["open", "blocked", "done", "cancelled"] as const) {
      expect(
        claimDeadline(
          row({ state, claim: state === "blocked" ? claim : null }),
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

  test("a mark wins an unfinished icon's colour, a result keeps done's", () => {
    expect(taskIcon(row({ state: "claimed" })).status).toBe("running");
    expect(taskIcon(row({ state: "done", attentionAt: 5 })).status).toBe(
      "done",
    );
    expect(taskIcon(row({ state: "open", attentionAt: 5 })).status).toBe(
      "attention",
    );
    expect(taskIcon(row({ state: "blocked" })).name).toBe("question");
    expect(taskIcon(row({ state: "cancelled" })).name).toBe("cancelled");
  });

  test("an open task waits for a claim, never a clock", () => {
    expect(taskIcon(row())).toEqual({ name: "task-open", status: null });
    expect(taskIcon(row({ attentionAt: 5 }))).toEqual({
      name: "task-open",
      status: "attention",
    });
  });
});

describe("the moves", () => {
  test("each state offers what a member may do", () => {
    expect(movesOf("open")).toEqual({
      edit: true,
      answer: false,
      unclaim: false,
      cancel: true,
      reopen: false,
    });
    expect(movesOf("blocked")).toEqual({
      edit: true,
      answer: true,
      unclaim: true,
      cancel: true,
      reopen: false,
    });
    expect(movesOf("claimed").unclaim).toBe(true);
    expect(movesOf("done")).toEqual({
      edit: false,
      answer: false,
      unclaim: false,
      cancel: false,
      reopen: true,
    });
    expect(movesOf("cancelled").reopen).toBe(true);
  });
});

describe("the brief's form", () => {
  const draft = { title: "Sweep", scope: "", text: "Do it", fileIds: [] };

  test("a title is required and one line, the brief is required", () => {
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
    expect(requestOf({ ...draft, text: "  " })).toMatchObject({
      field: "text",
    });
    expect(
      requestOf({
        ...draft,
        fileIds: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `f${i}`),
      }),
    ).toMatchObject({ field: "files" });
  });

  test("an empty scope is sent as none", () => {
    expect(requestOf({ ...draft, title: " Sweep ", scope: " " })).toEqual({
      body: { title: "Sweep", text: "Do it", scope: null, fileIds: [] },
    });
  });

  test("an edit sends only what changed, and the revision it opened on", () => {
    const opened = detail();
    const body = { ...draftOf(opened), text: "Do it now" };
    const request = requestOf(body);
    if (!("body" in request)) throw new Error("refused");
    expect(patchOf(request.body, opened, 4)).toEqual({
      editRevision: 4,
      text: "Do it now",
    });
    const unlinked = requestOf({ ...draftOf(opened), fileIds: [] });
    if (!("body" in unlinked)) throw new Error("refused");
    expect(patchOf(unlinked.body, opened, 4)).toEqual({
      editRevision: 4,
      fileIds: [],
    });
  });

  test("a server refusal finds its field", () => {
    expect(taskFieldOf("a title is one line")).toBe("title");
    expect(taskFieldOf("the brief is at most 16 KiB")).toBe("text");
    expect(taskFieldOf("at most 10 files")).toBe("files");
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
  onMarkedSocket(ev);
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
            row({ id: "b", state: "blocked", revision: 1 }),
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
    send(frame(row({ id: "a", revision: 2, state: "cancelled", entries: 1 })));
    unclaim();
    await load;
    expect(externalTasks.value).toEqual([]);
  });

  test.serial("Home's marked rows follow the frames", async () => {
    answer = () =>
      Response.json({
        tasks: [row({ id: "a", attentionAt: 10 })],
        count: 1,
        projectIds: HOME,
      });
    await loadMarkedTasks();
    expect(markedTasks.value?.tasks.map((t) => t.id)).toEqual(["a"]);
    onMarkedSocket(
      frame(row({ id: "b", projectId: "p9", attentionAt: 20, revision: 2 })),
    );
    expect(markedTasks.value?.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    // a project the read did not cover, an admin's other team, stays off
    onMarkedSocket(
      frame(row({ id: "c", projectId: "p8", attentionAt: 30, revision: 2 })),
    );
    expect(markedTasks.value?.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    onMarkedSocket(frame(row({ id: "a", revision: 2 })));
    expect(markedTasks.value).toEqual({
      tasks: [row({ id: "b", projectId: "p9", attentionAt: 20, revision: 2 })],
      count: 1,
    });
    onMarkedSocket({
      type: "externalTaskDeleted",
      projectId: "p9",
      taskId: "b",
    });
    expect(markedTasks.value).toEqual({ tasks: [], count: 0 });
  });

  test.serial(
    "a page read with a mark clears it with seen, a GET never",
    async () => {
      const marked = row({ attentionAt: 50, state: "blocked", claim });
      answer = (method, url) =>
        url === "/api/external-tasks/t1" || url.endsWith("/seen")
          ? Response.json(
              pageAnswer(
                method === "POST"
                  ? { ...marked, attentionAt: null, revision: 2 }
                  : marked,
              ),
            )
          : Response.json({ error: "no" }, { status: 404 });
      await loadExternalTask("t1");
      await settle();
      expect(calls.map((c) => c.call)).toContain(
        "POST /api/external-tasks/t1/seen",
      );
      expect(taskPage.value?.detail.task.attentionAt).toBeNull();
      calls = [];
      answer = (_method, url) =>
        url === "/api/external-tasks/t1"
          ? Response.json(pageAnswer(row({ revision: 3 })))
          : Response.json({ error: "no" }, { status: 404 });
      await loadExternalTask("t1");
      await settle();
      expect(calls.map((c) => c.call)).not.toContain(
        "POST /api/external-tasks/t1/seen",
      );
    },
  );

  test.serial("an unclaim names the state and the claim shown", async () => {
    const held = row({ state: "claimed", claim, revision: 4 });
    answer = () =>
      Response.json(pageAnswer({ ...held, state: "open", claim: null }));
    await moveExternalTask("t1", "unclaim", {
      state: "claimed",
      claimId: "c1",
      text: "wrong plan",
    });
    expect(calls).toEqual([
      {
        call: "POST /api/external-tasks/t1/unclaim",
        body: { state: "claimed", claimId: "c1", text: "wrong plan" },
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
    // a seen frame moves the row and reads nothing
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
    send(frame(row({ revision: 5, state: "claimed", claim })));
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
      send(frame(row({ id: "a", revision: 2, state: "claimed", claim })));
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
      hold = true;
      const load = loadClosedTasks("p1");
      send(frame(row({ id: "a", revision: 2, state: "done", entries: 1 })));
      await unclaim();
      await load;
      // the flight's pause, then the page again
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(gets("/api/projects/p1/external-tasks?closed=1")).toBe(2);
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
                  state: "cancelled",
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
        frame(
          row({ id: "x", title: "other", state: "cancelled", revision: 2 }),
        ),
      );
      expect(closedPages.value?.rows.map((t) => t.id)).toEqual(["new"]);
    },
  );

  test.serial(
    "Home's frames during its read land over the answer",
    async () => {
      answer = () =>
        Response.json({
          tasks: [row({ id: "a", attentionAt: 10, revision: 1 })],
          count: 1,
          projectIds: HOME,
        });
      hold = true;
      const load = loadMarkedTasks();
      send(frame(row({ id: "b", attentionAt: 20, revision: 2 })));
      send(frame(row({ id: "a", attentionAt: null, revision: 2 })));
      await unclaim();
      await load;
      expect(markedTasks.value?.tasks.map((t) => t.id)).toEqual(["b"]);
      expect(markedTasks.value?.count).toBe(1);
    },
  );

  test.serial(
    "Home keeps a frame from a project the read out is adding",
    async () => {
      answer = () => Response.json({ tasks: [], count: 0, projectIds: ["p1"] });
      await loadMarkedTasks();
      answer = () =>
        Response.json({ tasks: [], count: 0, projectIds: ["p1", "p7"] });
      hold = true;
      const load = loadMarkedTasks();
      send(frame(row({ id: "n", projectId: "p7", attentionAt: 20 })));
      await unclaim();
      await load;
      expect(markedTasks.value?.tasks.map((t) => t.id)).toEqual(["n"]);
    },
  );

  test.serial(
    "Home's first read drops what it saw from projects it does not cover",
    async () => {
      answer = () => Response.json({ tasks: [], count: 0, projectIds: ["p1"] });
      hold = true;
      const load = loadMarkedTasks();
      send(frame(row({ id: "x", projectId: "p8", attentionAt: 20 })));
      await unclaim();
      await load;
      expect(markedTasks.value?.tasks).toEqual([]);
    },
  );

  test.serial("Home reads again once cleared rows thin the card", async () => {
    answer = () =>
      Response.json({
        tasks: [row({ id: "a", attentionAt: 10 })],
        count: 60,
        projectIds: HOME,
      });
    await loadMarkedTasks();
    send(frame(row({ id: "a", attentionAt: null, revision: 2 })));
    await settle();
    expect(gets("/api/external-tasks?attention=1")).toBe(2);
  });

  test.serial("seen names the mark the page read", async () => {
    answer = (_method, url) =>
      url === "/api/external-tasks/t1" || url.endsWith("/seen")
        ? Response.json(pageAnswer(row({ attentionAt: 50 })))
        : Response.json({ error: "no" }, { status: 404 });
    await loadExternalTask("t1");
    await settle();
    expect(calls.find((c) => c.call.endsWith("/seen"))).toEqual({
      call: "POST /api/external-tasks/t1/seen",
      body: { attentionAt: 50 },
    });
    calls = [];
    await markSeen("t1", 70);
    expect(calls).toEqual([
      { call: "POST /api/external-tasks/t1/seen", body: { attentionAt: 70 } },
    ]);
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
            row({ revision: 2, entries: 1, state: "blocked", claim }),
          ),
          entries: [question],
        });
      hold = true;
      // the question's frame asks for the page; the seen's frame overtakes
      send(frame(row({ revision: 2, entries: 1, state: "blocked", claim })));
      send(
        frame(
          row({
            revision: 3,
            entries: 1,
            state: "blocked",
            claim,
            attentionAt: null,
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

  test.serial(
    "Home's frames replayed past 50 rows read the count again",
    async () => {
      const fifty = Array.from({ length: 50 }, (_, i) =>
        row({ id: `a${i}`, attentionAt: 100 - i }),
      );
      answer = () =>
        Response.json({ tasks: fifty, count: 60, projectIds: HOME });
      hold = true;
      const load = loadMarkedTasks();
      send(frame(row({ id: "b", attentionAt: 500, revision: 2 })));
      await unclaim();
      await load;
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(gets("/api/external-tasks?attention=1")).toBe(2);
    },
  );

  test.serial(
    "Home reads the count again after a delete past its rows",
    async () => {
      const fifty = Array.from({ length: 50 }, (_, i) =>
        row({ id: `a${i}`, attentionAt: 100 - i }),
      );
      answer = () =>
        Response.json({ tasks: fifty, count: 60, projectIds: HOME });
      await loadMarkedTasks();
      send({ type: "externalTaskDeleted", projectId: "p1", taskId: "zz" });
      await settle();
      expect(gets("/api/external-tasks?attention=1")).toBe(2);
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
        Response.json(pageAnswer(row({ revision: 2, state: "cancelled" })));
      await moveExternalTask("t1", "cancel", { state: "open" });
      expect(taskPage.value?.detail.task.state).toBe("cancelled");
    },
  );
});
