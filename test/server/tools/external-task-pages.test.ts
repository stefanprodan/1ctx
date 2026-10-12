// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The external_task tool over the area on a test database: its
// arguments, and pages that fit a small result cut and read on to the
// end without skipping or repeating.

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type ExternalTasksPort,
  makeExternalTaskTool,
  parseExternalTaskArgs,
} from "../../../src/server/tools/builtin/external-task.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type {
  ToolContext,
  ToolResult,
} from "../../../src/server/tools/types.ts";
import { fixture } from "../external-tasks/fixture.ts";

type Fixture = ReturnType<typeof fixture>;

const port = (f: Fixture): ExternalTasksPort => ({
  ...f.area.chat,
  fileId: () => null,
  userZone: () => "UTC",
});

const context = (
  f: Fixture,
  resultCut: number,
  subagent = false,
): ToolContext => ({
  web: null,
  sendId: "send00000001",
  messageId: "tool00000001",
  disabledCapabilities: [],
  actor: {
    projectId: f.projectId,
    userId: f.owner.id,
    agentId: "a1",
    agentName: "coder",
    sessionId: "chat00000001",
    origin: "chat",
    sendStartedAt: 0,
  },
  now: () => 0,
  signal: new AbortController().signal,
  budget: { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: { ...DEFAULT_LIMITS, resultCut },
  ...(subagent ? { subagent: { uploadsFrom: "chat00000001" } } : {}),
});

function call(
  f: Fixture,
  args: Record<string, unknown>,
  resultCut = DEFAULT_LIMITS.resultCut,
  subagent = false,
): Promise<ToolResult> {
  return new Registry([makeExternalTaskTool(port(f), true)]).run(
    { id: "c1", name: "external_task", arguments: JSON.stringify(args) },
    context(f, resultCut, subagent),
  );
}

async function ok(f: Fixture, args: Record<string, unknown>, cut?: number) {
  const result = await call(f, args, cut);
  expect(result.error).toBe(false);
  if (cut !== undefined) expect(result.content.length).toBeLessThan(cut);
  return result.content;
}

// the quoted text of the one fenced block after label
function quotedAfter(content: string, label: string): string {
  const at = content.indexOf(`${label}, quoted as data`);
  const open = content.indexOf("text\n", at) + 5;
  const fence = content.slice(
    content.lastIndexOf("\n", open - 6) + 1,
    open - 5,
  );
  return content.slice(open, content.indexOf(`\n${fence}`, open));
}

const number = (text: string, pattern: RegExp) =>
  Number(pattern.exec(text)?.[1] ?? Number.NaN);

describe("the arguments", () => {
  test("each action takes its own fields and the read-only set refuses writes", () => {
    expect(() =>
      parseExternalTaskArgs({ action: "list", id: "x" }, true),
    ).toThrow("id is not a field of list");
    expect(() =>
      parseExternalTaskArgs({ action: "create", title: "T", text: "B" }),
    ).toThrow("action must be list, show");
    expect(() =>
      parseExternalTaskArgs(
        { action: "unclaim", id: "t", state: "claimed", text: "Why." },
        true,
      ),
    ).toThrow("unclaim needs the claimId show gave");
    expect(() =>
      parseExternalTaskArgs({ action: "edit", id: "t", editRevision: 0 }, true),
    ).toThrow("edit needs a title, text, scope or files to change");
    expect(() =>
      parseExternalTaskArgs({ action: "list", states: ["closed"] }, true),
    ).toThrow("states must be a list of");
    expect(
      parseExternalTaskArgs({ action: "cancel", id: "t", state: "open" }, true),
    ).toEqual({
      action: "cancel",
      id: "t",
      body: { state: "open", text: "" },
    });
  });

  test("a subagent's forged write is refused with nothing written", async () => {
    using f = fixture();
    const result = await call(
      f,
      { action: "create", title: "T", text: "B" },
      DEFAULT_LIMITS.resultCut,
      true,
    );
    expect(result.content).toBe(
      "Error: external task changes are only offered in a chat's main rounds",
    );
    expect(f.area.byProject(f.projectId).tasks).toEqual([]);
  });
});

describe("pages", () => {
  test("a brief past the cut reads on by offset, and a moved ref starts again", async () => {
    using f = fixture();
    const brief = Array.from({ length: 120 }, (_, i) => `Step ${i}.`).join(
      "\n",
    );
    const id = f.area.create(f.owner.id, f.projectId, {
      title: "Long",
      text: brief,
      fileIds: [],
    }).task.task.id;
    const first = await ok(f, { action: "show", id }, 1000);
    let read = quotedAfter(first, "Its brief");
    let offset = number(first, /offset (\d+), ref 0\./);
    while (!Number.isNaN(offset)) {
      const page = await ok(f, { action: "show", id, offset, ref: 0 }, 1000);
      read += quotedAfter(page, "Its brief");
      offset = number(page, /ref 0, offset (\d+)\./);
    }
    expect(read).toBe(brief);
    f.area.edit(id, { editRevision: 0, title: "Longer" });
    const moved = await ok(f, { action: "show", id, offset: 50, ref: 0 }, 1000);
    expect(moved).toStartWith(
      "The brief changed since ref 0, so this starts again at 0.",
    );
    expect(moved).toContain("Characters 0 to ");
  });

  test("entries page newest first by before, never skipping or repeating", async () => {
    using f = fixture();
    const task = f.create();
    f.fillEntries(task.id, 40);
    const all = f.area.store.entries(task.id, null).entries.map((e) => e.id);
    const seen: string[] = [];
    let args: Record<string, unknown> = { action: "show", id: task.id };
    for (let pages = 0; pages < 40; pages++) {
      const page = await ok(f, args, 1500);
      seen.push(...[...page.matchAll(/^Entry (\w+): /gm)].map((m) => m[1]!));
      const before = /before (\w+)\.$/m.exec(page)?.[1];
      if (before === undefined) break;
      // an entry added between two pages is newer, so the next page
      // never shows it
      if (pages === 1) {
        transact(f.db, () => ({
          result: f.area.store.append(task.id, {
            claimId: null,
            kind: "answer",
            text: "late",
            links: [],
            userId: f.owner.id,
            keyName: null,
            claimEnd: null,
            at: f.now() + 1,
          }),
        }));
      }
      args = { action: "show", id: task.id, before };
    }
    expect(seen).toEqual(all.slice(0, seen.length));
    expect(seen.length).toBe(40);
  });

  test("an entry longer than a page is cut and read on by its id", async () => {
    using f = fixture();
    const held = f.task("claimed");
    const long = "word ".repeat(600).trim();
    f.area.report(f.key, held.id, held.claimId!, "progress", long, []);
    const first = await ok(
      f,
      { action: "show", id: held.id, before: "newest" },
      1200,
    );
    expect(first).not.toContain("Its brief");
    const entry = /^Entry (\w+): progress/m.exec(first)![1]!;
    let read = quotedAfter(first, "Its text");
    let offset = number(first, new RegExp(`entry ${entry}, offset (\\d+)\\.`));
    while (!Number.isNaN(offset)) {
      const page = await ok(
        f,
        { action: "show", id: held.id, entry, offset },
        1200,
      );
      read += quotedAfter(page, `Entry ${entry}'s text`);
      offset = number(page, new RegExp(`entry ${entry}, offset (\\d+)\\.`));
    }
    expect(read).toBe(long);
    const result = await call(f, {
      action: "show",
      id: held.id,
      entry: "nope00000000",
      offset: 0,
    });
    expect(result.content).toBe("Error: no entry with that id on this task");
  });

  test("list pages by cursor under the cut", async () => {
    using f = fixture();
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) {
      ids.add(f.create(`Task number ${i}`).id);
      f.advance();
    }
    const seen: string[] = [];
    let args: Record<string, unknown> = { action: "list" };
    for (let pages = 0; pages < 12; pages++) {
      const page = await ok(f, args, 1000);
      seen.push(...[...page.matchAll(/" id (\w+), open/g)].map((m) => m[1]!));
      const after = /after ([\w.]+)\.$/m.exec(page)?.[1];
      if (after === undefined) {
        expect(page).toEndWith("The end of the list.");
        break;
      }
      args = { action: "list", after };
    }
    expect(seen.length).toBe(12);
    expect(new Set(seen)).toEqual(ids);
  });
});

describe("show and moves", () => {
  test("a list keeps the last report after a claim, and a deleted user's key is named", async () => {
    using f = fixture();
    const held = f.task("claimed");
    f.area.report(f.key, held.id, held.claimId!, "progress", "Halfway.", []);
    f.area.report(f.key, held.id, held.claimId!, "unclaim", "Later.", []);
    f.area.claim(f.key, held.id);
    const list = await ok(f, { action: "list" });
    expect(list).toContain('last unclaim 1970-01-02 00:00: "Later."');
    expect(list).not.toContain("last claim");
    f.db.exec("update external_task_entries set user_id = null");
    const shown = await ok(f, { action: "show", id: held.id });
    expect(shown).toMatch(
      /^Entry \w+: claim by a deleted user via laptop at /m,
    );
    expect(shown).not.toContain("by 1ctx");
  });

  test("a page ending on a cut entry points on only while older ones remain", async () => {
    using f = fixture();
    const held = f.task("claimed");
    const long = "word ".repeat(600).trim();
    const longId = f.area.report(
      f.key,
      held.id,
      held.claimId!,
      "progress",
      long,
      [],
    ).entry.id;
    // the long one is cut on its own page, the claim's entry older still
    const cut = await ok(
      f,
      { action: "show", id: held.id, before: "newest" },
      1200,
    );
    expect(cut).toContain("cut: characters 0 to");
    expect(cut).toContain(`before ${longId}.`);
    const last = await ok(
      f,
      { action: "show", id: held.id, before: longId },
      1200,
    );
    expect(last).toMatch(
      new RegExp(
        `^Entry \\w+: claim by @owner via laptop at .+, claim ${held.claimId}$`,
        "m",
      ),
    );
    expect(last).not.toContain("More entries");
    // a different text, since a repeat of the last entry adds none
    f.area.report(f.key, held.id, held.claimId!, "progress", `${long}.`, []);
    const newer = await ok(
      f,
      { action: "show", id: held.id, before: "newest" },
      1200,
    );
    const shownId = /^Entry (\w+): progress/m.exec(newer)![1]!;
    expect(newer).toContain(`before ${shownId}.`);
  });

  test("only a claimed task says when it is unclaimed", async () => {
    using f = fixture();
    const idle = "A claimed task is unclaimed after 24 hours without a report.";
    for (const state of ["open", "blocked", "done", "cancelled"] as const) {
      const task = f.task(state);
      expect(await ok(f, { action: "show", id: task.id })).not.toContain(idle);
    }
    const claimed = f.task("claimed");
    expect(await ok(f, { action: "show", id: claimed.id })).toContain(idle);
  });

  test("answer and cancel may name the claim they saw and are held to it", async () => {
    using f = fixture();
    const blocked = f.task("blocked");
    const stale =
      "Error: the task changed since you read it: nothing was written. Show it again and check with the user";
    const entries = () => f.area.store.byId(blocked.id)!.entries;
    const before = entries();
    for (const args of [
      {
        action: "answer",
        state: "blocked",
        claimId: "gone00000000",
        text: "A.",
      },
      { action: "cancel", state: "blocked", claimId: "gone00000000" },
    ]) {
      const result = await call(f, { ...args, id: blocked.id });
      expect(result.content).toBe(stale);
    }
    expect(entries()).toBe(before);
    expect(
      await ok(f, {
        action: "answer",
        id: blocked.id,
        state: "blocked",
        claimId: blocked.claimId,
        text: "Take path A.",
      }),
    ).toContain("now claimed");
    expect(
      await ok(f, {
        action: "cancel",
        id: blocked.id,
        state: "claimed",
        claimId: blocked.claimId,
      }),
    ).toContain("now cancelled");
    const open = f.task("open");
    const named = await call(f, {
      action: "cancel",
      id: open.id,
      state: "open",
      claimId: blocked.claimId,
    });
    expect(named.content).toBe(stale);
    expect(
      (
        await call(f, {
          action: "answer",
          id: open.id,
          state: "open",
          claimId: "",
        })
      ).content,
    ).toBe("Error: answer needs the text of the answer");
    expect(
      parseExternalTaskArgs(
        { action: "cancel", id: "t", state: "open", claimId: " c1 " },
        true,
      ),
    ).toEqual({
      action: "cancel",
      id: "t",
      body: { state: "open", text: "", claimId: "c1" },
    });
    expect(() =>
      parseExternalTaskArgs(
        { action: "cancel", id: "t", state: "open", claimId: "" },
        true,
      ),
    ).toThrow("cancel needs the claimId show gave");
    expect(
      parseExternalTaskArgs(
        { action: "cancel", id: "t", state: "open", claimId: null },
        true,
      ),
    ).toEqual({ action: "cancel", id: "t", body: { state: "open", text: "" } });
    expect(
      parseExternalTaskArgs(
        {
          action: "answer",
          id: "t",
          state: "blocked",
          text: "A",
          claimId: null,
        },
        true,
      ),
    ).toEqual({
      action: "answer",
      id: "t",
      body: { state: "blocked", text: "A" },
    });
    expect(() =>
      parseExternalTaskArgs(
        {
          action: "unclaim",
          id: "t",
          state: "claimed",
          text: "R",
          claimId: null,
        },
        true,
      ),
    ).toThrow("unclaim needs the claimId show gave");
  });
});
