// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type AttachPorts,
  AttachState,
} from "../../../src/client/composer/Attach.state.ts";
import {
  attachedLines,
  skippedLines,
  summaryOf,
} from "../../../src/client/composer/Attach.words.ts";
import type { DraftUpload } from "../../../src/client/composer/draft.ts";
import type {
  StagedUpload,
  StagedUploads,
  UploadLimits,
} from "../../../src/shared/contracts/knowledge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const LIMITS: UploadLimits = {
  itemBytes: 1000,
  fileBytes: 100,
  uploadBytes: 10_000,
  uploadFiles: 100,
  perMessage: 3,
  stagedItems: 20,
};

const PNG = new Uint8Array([137, 80, 78, 71, 0, 0, 0, 1, 255, 254]);
// the first bytes of a zip's local file header
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

const file = (name: string, body: BlobPart = "text", modified = 1) =>
  new File([body], name, { lastModified: modified });

function stagedAs(
  id: string | null,
  attempt: string,
  changes: Partial<StagedUpload> = {},
): StagedUpload {
  return {
    id,
    attempt,
    name: "notes.md",
    archive: false,
    folder: "",
    files: id === null ? 0 : 1,
    bytes: 4,
    saved: id === null ? [] : ["notes.md"],
    skipped: [],
    skippedTotal: 0,
    renamed: 0,
    expiresAt: id === null ? null : 1000,
    ...changes,
  };
}

const refusal = (words: string, status: number) =>
  Object.assign(new Error(words), { status });

type Call = {
  projectId: string;
  file: File;
  attempt: string;
  signal: AbortSignal;
  progress: (sent: number, total: number) => void;
  answer: ReturnType<typeof deferred<StagedUpload>>;
};

function harness(
  saved: DraftUpload[] = [],
  lists: [string, StagedUpload[]][] = [],
) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const forgotten: string[] = [];
  const reloads: string[] = [];
  const saves: DraftUpload[][] = [];
  const waits: ReturnType<typeof deferred<void>>[] = [];
  // stamps only grow; every project in `lists` was asked for at the start
  let clock = 0;
  const asked = new Map<string, number>(lists.map(([id]) => [id, ++clock]));
  let reloadOk = true;
  const held = new Map<string, StagedUploads>(
    lists.map(([id, items]) => [id, { items, limits: LIMITS }]),
  );
  let user: string | null = "u1";
  let minted = 0;
  const ports: AttachPorts = {
    stage: (projectId, picked, attempt, options) => {
      const answer = deferred<StagedUpload>();
      calls.push({
        projectId,
        file: picked,
        attempt,
        signal: options.signal,
        progress: options.onProgress,
        answer,
      });
      options.signal.addEventListener("abort", () =>
        answer.reject(new DOMException("aborted", "AbortError")),
      );
      return answer.promise;
    },
    remove: async (_projectId, id) => {
      removed.push(id);
    },
    forget: (_projectId, attempt) => {
      forgotten.push(attempt);
    },
    reload: async (projectId: string) => {
      reloads.push(projectId);
      return reloadOk;
    },
    list: (projectId) => held.get(projectId) ?? null,
    stamp: () => ++clock,
    asked: (projectId) => asked.get(projectId) ?? 0,
    wait: () => {
      const gate = deferred<void>();
      waits.push(gate);
      return gate.promise;
    },
    currentUser: () => user,
    mint: () => `try${++minted}`,
    save: (uploads) => {
      saves.push(uploads);
    },
  };
  const state = new AttachState(ports, saved);
  return {
    state,
    calls,
    removed,
    forgotten,
    reloads,
    saves,
    waits,
    held,
    // a list asked for now, and answered
    list: (projectId: string, items: StagedUpload[]) => {
      held.set(projectId, { items, limits: LIMITS });
      asked.set(projectId, ++clock);
      state.reconcile(held.get(projectId) ?? null);
    },
    // a list asked for long ago that answers only now
    lateList: (projectId: string, items: StagedUpload[]) => {
      held.set(projectId, { items, limits: LIMITS });
      state.reconcile(held.get(projectId) ?? null);
    },
    failReloads: () => {
      reloadOk = false;
    },
    signOut: () => {
      user = null;
    },
  };
}

// lets the state's awaited steps run
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe("picking", () => {
  test("a file is judged by the limits the list answered, then waits its turn", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add(
      [
        file("notes.md"),
        file("shot.png", PNG),
        file("big.md", "x".repeat(101)),
        file("----.md"),
        file("huge.zip", "x".repeat(1001)),
        file("docs.zip", ZIP),
        file(".DS_Store"),
      ],
      true,
    );
    await settle();
    // three are taken, the refused ones among them; the rest are left out
    expect(h.state.refusal.value).toBe(
      "At most 3 files per message. 3 were left out.",
    );
    expect(h.state.shown.map((item) => [item.name, item.phase])).toEqual([
      ["notes.md", "sending"],
      ["shot.png", "skipped"],
      ["big.md", "skipped"],
    ]);
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "shot.png", note: "not text", status: null },
      { name: "big.md", note: "over the file limit", status: null },
    ]);
    expect(h.calls).toHaveLength(1);
  });

  test("an archive is told from its bytes and a bad name is a skipped line", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add(
      [file("docs.zip", ZIP), file("----"), file("huge.md", "x".repeat(1001))],
      true,
    );
    await settle();
    expect(h.state.shown.map((item) => [item.archive, item.phase])).toEqual([
      [true, "sending"],
      [false, "skipped"],
      [false, "skipped"],
    ]);
    expect(skippedLines(h.state.shown).map((line) => line.note)).toEqual([
      "no letters or digits",
      "over the 32 MB upload limit",
    ]);
  });

  test("the same file picked again is not added twice", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    const picked = file("notes.md");
    await h.state.add([picked], true);
    await h.state.add([picked], true);
    expect(h.state.shown).toHaveLength(1);
  });

  test("an agent that cannot read files refuses the pick", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("notes.md")], false);
    expect(h.state.refusal.value).toBe("This agent cannot read files.");
    expect(h.state.shown).toHaveLength(0);
  });

  test("without a list the limits are asked for, and a pick waits for them", async () => {
    const h = harness();
    h.state.show("p1");
    await h.state.add([file("notes.md")], true);
    expect(h.reloads).toEqual(["p1"]);
    expect(h.state.refusal.value).toBe(
      "The files could not be added. Try again.",
    );
    expect(h.state.shown).toHaveLength(0);
  });
});

describe("the queue", () => {
  test("uploads one at a time, keeps the staged ids in the draft, and Send waits", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.state.busy).toBe(true);
    expect(h.state.ids).toEqual([]);
    h.calls[0]?.progress(2, 4);
    expect(summaryOf(h.state.shown)).toEqual({
      busy: true,
      main: "Uploading 1 of 2",
      more: "a.md · 50%",
    });
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(summaryOf(h.state.shown).main).toBe("Uploading 2 of 2");
    h.calls[1]?.answer.resolve(stagedAs("up2", "try2", { name: "b.md" }));
    await settle();
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual(["up1", "up2"]);
    expect(h.saves.at(-1)).toEqual([
      { projectId: "p1", id: "up1", name: "a.md" },
      { projectId: "p1", id: "up2", name: "b.md" },
    ]);
    expect(summaryOf(h.state.shown)).toEqual({
      busy: false,
      main: "2 files attached",
      more: "",
    });
  });

  test("a server refusal is a skipped line with its status and blocks nothing", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    h.calls[0]?.answer.reject(refusal("the server is busy, try again", 503));
    await settle();
    h.calls[1]?.answer.resolve(stagedAs("up2", "try2", { name: "b.md" }));
    await settle();
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual(["up2"]);
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "a.md", note: "the server is busy, try again", status: 503 },
    ]);
    expect(summaryOf(h.state.shown)).toEqual({
      busy: false,
      main: "1 file attached",
      more: "1 skipped",
    });
  });

  test("an item that left no file is a skipped line over its members", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("shots.zip", ZIP)], true);
    await settle();
    h.calls[0]?.answer.resolve(
      stagedAs(null, "try1", {
        name: "shots.zip",
        archive: true,
        folder: "shots",
        skipped: [{ index: 0, name: "a.png", reason: "not-text" }],
        skippedTotal: 3,
      }),
    );
    await settle();
    expect(h.state.ids).toEqual([]);
    expect(summaryOf(h.state.shown)).toEqual({
      busy: false,
      main: "No files attached",
      more: "4 skipped",
    });
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "shots.zip", note: "nothing to upload", status: null },
      { name: "shots/a.png", note: "not text", status: null },
      { name: "shots/...", note: "2 more skipped", status: null },
    ]);
  });
});

describe("removing", () => {
  test("a staged item is deleted, the one sending is aborted and forgotten", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md"), file("c.md")], true);
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    const [a, b] = h.state.shown;
    h.state.remove(a?.key ?? 0);
    expect(h.removed).toEqual(["up1"]);
    h.state.remove(b?.key ?? 0);
    expect(h.calls[1]?.signal.aborted).toBe(true);
    expect(h.forgotten).toEqual(["try2"]);
    await settle();
    // the queue goes on with what is left
    expect(h.calls).toHaveLength(3);
    expect(h.state.shown.map((item) => item.name)).toEqual(["c.md"]);
    expect(h.saves.at(-1)).toEqual([]);
  });

  test("the X mid-upload removes everything, staged, sending and the log", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add(
      [file("a.md"), file("shot.png", PNG), file("b.md")],
      true,
    );
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    expect(h.state.busy).toBe(true);
    h.state.clear();
    await settle();
    expect(h.state.shown).toEqual([]);
    expect(h.removed).toEqual(["up1"]);
    expect(h.calls[1]?.signal.aborted).toBe(true);
    expect(h.forgotten).toEqual(["try3"]);
    expect(h.state.busy).toBe(false);
    expect(h.saves.at(-1)).toEqual([]);
  });

  test("an answer that lands after its item was removed is deleted", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md")], true);
    await settle();
    // the transport ignores the abort and answers anyway
    const late = h.calls[0]?.answer;
    h.state.clear();
    late?.resolve(stagedAs("up1", "try1"));
    await settle();
    expect(h.state.shown).toEqual([]);
  });
});

describe("the staged list", () => {
  test("a reload brings the draft's files back by their ids", () => {
    const h = harness(
      [
        { projectId: "p1", id: "up1", name: "a.md" },
        { projectId: "p2", id: "up7", name: "other.md" },
      ],
      [["p1", [stagedAs("up1", "t1", { name: "a.md" })]]],
    );
    h.state.show("p1");
    expect(h.state.ids).toEqual(["up1"]);
    // nothing changed, so nothing is written, and the other project's id stays
    expect(h.saves).toEqual([]);
  });

  test("an id a fresh list no longer holds is a skipped line and Send stays on", () => {
    const h = harness(
      [{ projectId: "p1", id: "gone", name: "old-notes.md" }],
      [["p1", []]],
    );
    h.state.show("p1");
    // the list held is from before: it is checked, and a newer one asked for
    expect(h.state.busy).toBe(true);
    expect(h.reloads).toEqual(["p1"]);
    expect(h.saves).toEqual([]);
    h.list("p1", []);
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual([]);
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "old-notes.md", note: "expired, add it again", status: null },
    ]);
    expect(h.saves.at(-1)).toEqual([]);
  });

  test("a staged item that leaves the list moves to the log", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md")], true);
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    h.list("p1", []);
    expect(h.state.ids).toEqual([]);
    expect(skippedLines(h.state.shown)[0]?.note).toBe("expired, add it again");
  });

  test("a lost answer is checked: adopted when the list holds its attempt", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    h.calls[0]?.answer.reject(refusal("the server did not answer", 0));
    await settle();
    expect(summaryOf(h.state.shown)).toEqual({
      busy: true,
      main: "Checking",
      more: "a.md",
    });
    // the next upload waits for the list
    expect(h.calls).toHaveLength(1);
    expect(h.reloads).toEqual(["p1"]);
    h.list("p1", [stagedAs("up1", "try1", { name: "a.md" })]);
    await settle();
    expect(h.state.ids).toEqual(["up1"]);
    expect(h.calls).toHaveLength(2);
  });

  test("a lost answer the list does not hold was not sent, and is forgotten", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md")], true);
    await settle();
    h.calls[0]?.answer.reject(refusal("the server did not answer", 0));
    await settle();
    h.list("p1", []);
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "a.md", note: "not sent, add it again", status: null },
    ]);
    expect(h.forgotten).toEqual(["try1"]);
    expect(h.state.busy).toBe(false);
  });
});

describe("the races a review found", () => {
  test("two picks at once share the room, and Send waits while one is read", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    const first = h.state.add([file("a.md"), file("b.md")], true);
    const second = h.state.add([file("c.md"), file("d.md")], true);
    expect(h.state.busy).toBe(true);
    await Promise.all([first, second]);
    await settle();
    expect(h.state.shown.map((item) => item.name)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(h.state.refusal.value).toBe(
      "At most 3 files per message. 1 was left out.",
    );
  });

  test("the X while a pick is still read: the file never joins", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    const adding = h.state.add([file("a.md"), file("b.md")], true);
    h.state.clear();
    await adding;
    await settle();
    expect(h.state.shown).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.state.busy).toBe(false);
  });

  test("a send answered after the composer is gone writes no draft", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md")], true);
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    const before = h.saves.length;
    h.state.dispose();
    h.state.sent(["up1"]);
    expect(h.saves).toHaveLength(before);
  });

  test("a list from before the draft was written cannot call its files gone", () => {
    // a fork staged up9 after p1's list was cached
    const h = harness(
      [{ projectId: "p1", id: "up9", name: "notes.md" }],
      [["p1", []]],
    );
    h.state.show("p1");
    expect(h.state.ids).toEqual([]);
    expect(h.state.busy).toBe(true);
    expect(summaryOf(h.state.shown)).toEqual({
      busy: true,
      main: "Checking",
      more: "notes.md",
    });
    // the id stays in the draft all along
    expect(h.saves).toEqual([]);
    h.list("p1", [stagedAs("up9", "t9")]);
    expect(h.state.ids).toEqual(["up9"]);
    expect(h.state.busy).toBe(false);
  });

  test("an old request that answers late proves nothing either", () => {
    const h = harness(
      [{ projectId: "p1", id: "up9", name: "notes.md" }],
      [["p1", []]],
    );
    h.state.show("p1");
    h.lateList("p1", []);
    // still checked, and a list is asked for again
    expect(h.state.busy).toBe(true);
    expect(h.reloads).toEqual(["p1", "p1"]);
    h.list("p1", [stagedAs("up9", "t9")]);
    expect(h.state.ids).toEqual(["up9"]);
  });

  test("no list is held for the draft's files: one is asked for", () => {
    const h = harness([{ projectId: "p1", id: "up9", name: "notes.md" }]);
    h.state.show("p1");
    expect(h.state.busy).toBe(true);
    expect(h.reloads).toEqual(["p1"]);
  });

  test("the list cannot be loaded: the checks end and Send is free again", async () => {
    const h = harness(
      [{ projectId: "p1", id: "up9", name: "notes.md" }],
      [["p1", []]],
    );
    h.failReloads();
    h.state.show("p1");
    await settle();
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual([]);
    expect(skippedLines(h.state.shown)).toEqual([
      {
        name: "notes.md",
        note: "could not be checked, add it again",
        status: null,
      },
    ]);
  });

  test("the X frees Send at once, and the next pick does not wait behind the old read", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    const slow = file("slow.md");
    const gate = deferred<ArrayBuffer>();
    slow.arrayBuffer = () => gate.promise;
    const old = h.state.add([slow], true);
    await settle();
    h.state.clear();
    expect(h.state.busy).toBe(false);
    await h.state.add([file("next.md")], true);
    await settle();
    expect(h.state.shown.map((item) => item.name)).toEqual(["next.md"]);
    gate.resolve(new ArrayBuffer(0));
    await old;
    await settle();
    // the old pick never joins, and never counts Send out again
    expect(h.state.shown.map((item) => item.name)).toEqual(["next.md"]);
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "next.md" }));
    await settle();
    expect(h.state.busy).toBe(false);
  });

  test("a saved file still checked goes back to wait when Home moves on", () => {
    const h = harness(
      [{ projectId: "p1", id: "up9", name: "notes.md" }],
      [
        ["p1", []],
        ["p2", []],
      ],
    );
    h.state.show("p1");
    h.state.show("p2");
    expect(h.removed).toEqual([]);
    h.held.set("p1", { items: [stagedAs("up9", "t9")], limits: LIMITS });
    h.state.show("p1");
    expect(h.state.ids).toEqual(["up9"]);
  });

  test("the server still holds the removed upload's place: the next one waits and goes again", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    h.state.remove(h.state.shown[0]?.key ?? 0);
    await settle();
    expect(h.calls).toHaveLength(2);
    h.calls[1]?.answer.reject(refusal("an upload is running", 409));
    await settle();
    // not skipped: it waits its turn again
    expect(h.state.shown.map((item) => item.phase)).toEqual(["waiting"]);
    expect(h.state.busy).toBe(true);
    h.waits[0]?.resolve();
    await settle();
    expect(h.calls).toHaveLength(3);
    h.calls[2]?.answer.resolve(stagedAs("up2", "try2", { name: "b.md" }));
    await settle();
    expect(h.state.ids).toEqual(["up2"]);
  });

  test("another 409 is a refusal, not a wait", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md")], true);
    await settle();
    h.calls[0]?.answer.reject(
      refusal("this upload attempt already exists", 409),
    );
    await settle();
    expect(h.waits).toEqual([]);
    expect(skippedLines(h.state.shown)[0]?.status).toBe(409);
  });
});

describe("the project and the person", () => {
  test("Home moves to another project: the queue dies, staged files are put away and come back", async () => {
    const h = harness(
      [],
      [
        ["p1", []],
        ["p2", []],
      ],
    );
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    h.state.show("p2");
    expect(h.calls[1]?.signal.aborted).toBe(true);
    expect(h.forgotten).toEqual(["try2"]);
    expect(h.state.shown).toEqual([]);
    expect(h.state.ids).toEqual([]);
    h.held.set("p1", {
      items: [stagedAs("up1", "try1", { name: "a.md" })],
      limits: LIMITS,
    });
    h.state.show("p1");
    expect(h.state.ids).toEqual(["up1"]);
    // the draft kept it all along
    expect(h.saves.at(-1)).toEqual([
      { projectId: "p1", id: "up1", name: "a.md" },
    ]);
  });

  test("another person signed in: the queue dies and nothing more is asked", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("b.md")], true);
    await settle();
    h.signOut();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1"));
    await settle();
    await h.state.add([file("c.md")], true);
    // the answer is ignored and nothing more goes out
    expect(h.calls).toHaveLength(1);
    expect(h.state.ids).toEqual([]);
    expect(h.saves).toEqual([]);
  });
});

describe("the send", () => {
  test("clears only what it carried, and the log with it", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("a.md"), file("shot.png", PNG)], true);
    await settle();
    h.calls[0]?.answer.resolve(stagedAs("up1", "try1", { name: "a.md" }));
    await settle();
    const carried = h.state.ids;
    // added while the send was on its way
    await h.state.add([file("late.md")], true);
    await settle();
    h.calls[1]?.answer.resolve(stagedAs("up2", "try2", { name: "late.md" }));
    await settle();
    h.state.sent(carried);
    expect(h.state.shown.map((item) => item.name)).toEqual(["late.md"]);
    expect(h.state.ids).toEqual(["up2"]);
    expect(h.saves.at(-1)).toEqual([
      { projectId: "p1", id: "up2", name: "late.md" },
    ]);
  });
});

describe("the words", () => {
  test("the Attached list says each item's state, an archive by its count", async () => {
    const h = harness([], [["p1", []]]);
    h.state.show("p1");
    await h.state.add([file("docs.zip", ZIP), file("b.md")], true);
    await settle();
    h.calls[0]?.answer.resolve(
      stagedAs("up1", "try1", {
        name: "docs.zip",
        archive: true,
        // its members sit under one folder of their own: none is added
        folder: "",
        files: 43,
        skipped: [{ index: 2, name: "Docs/Read Me.md", reason: "duplicate" }],
        skippedTotal: 1,
      }),
    );
    await settle();
    h.calls[1]?.progress(1, 4);
    expect(
      attachedLines(h.state.shown).map(({ name, note, running }) => [
        name,
        note,
        running,
      ]),
    ).toEqual([
      ["docs.zip", "43 files", false],
      ["b.md", "sending 25%", true],
    ]);
    // a member is named under the folder the server added, none here
    expect(skippedLines(h.state.shown)).toEqual([
      { name: "Docs/Read Me.md", note: "duplicate name", status: null },
    ]);
  });
});
