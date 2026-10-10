// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  loadDraftTask,
  taskFailing,
} from "../../../src/client/data/session-drafts.ts";
import { onSocket } from "../../../src/client/data/sessions.ts";
import {
  agoTickMs,
  changedFields,
  changedLines,
  createTexts,
  INERT_WORDS,
  lineDetail,
  lineDiff,
  lineHead,
  nameTarget,
  opens,
  proposalAction,
  proposalLines,
  updateTexts,
  visibleParts,
} from "../../../src/client/transcript/Proposal.model.ts";
import {
  CUT_LINES,
  Details,
  Proposal,
  TextFold,
} from "../../../src/client/transcript/Proposal.tsx";
import {
  groupRows,
  type ReplyNode,
} from "../../../src/client/transcript/rows.ts";
import type { AutomationDraft } from "../../../src/shared/contracts/automation-draft.ts";
import {
  createDraft,
  proposalRows,
  task,
  taskDraft,
} from "../../fixtures/sessions/drafts.ts";

// a text as tag characters, the way ASCII is smuggled
const tag = (text: string) =>
  [...text]
    .map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)))
    .join("");

const turn = (rows: ReturnType<typeof proposalRows>) =>
  groupRows(rows).find((node) => node.kind === "reply") as ReplyNode;

const chat = { forkedFromId: null, createdAt: 1 };
// a fork made after the source's rows were written
const fork = { forkedFromId: "source", createdAt: 5_000 };

describe("which calls draw a line", () => {
  test("only an automation call with one of the five actions proposes", () => {
    const call = (name: string, args: unknown) => ({
      id: "c",
      name,
      arguments: JSON.stringify(args),
    });
    expect(proposalAction(call("automation", { action: "create" }))).toBe(
      "create",
    );
    expect(proposalAction(call("automation", { action: "run" }))).toBe("run");
    expect(proposalAction(call("automation", { action: "list" }))).toBeNull();
    expect(proposalAction(call("bash", { action: "create" }))).toBeNull();
    expect(
      proposalAction({ id: "c", name: "automation", arguments: "{" }),
    ).toBeNull();
  });

  test("each call's draft is the one naming its tool row", () => {
    const node = turn(
      proposalRows([
        { id: "a", args: { action: "create", name: "x" } },
        { id: "b", args: { action: "list" } },
        { id: "c", args: { action: "suspend", id: "task-1" } },
      ]),
    );
    const first = createDraft({ id: "d1", messageId: "tool-a" });
    const third = taskDraft("suspend", { id: "d3", messageId: "tool-c" });
    const lines = proposalLines(node, [third, first], chat);
    expect(lines.map((l) => l.kind === "draft" && l.draft.id)).toEqual([
      "d1",
      "d3",
    ]);
  });

  test("a refused call and one whose draft has not arrived draw nothing", () => {
    const node = turn(
      proposalRows([
        { id: "a", args: { action: "create" }, status: "failed" },
        { id: "b", args: { action: "run", id: "task-1" } },
      ]),
    );
    expect(proposalLines(node, [], chat)).toEqual([]);
  });

  test("a fork's copied proposal is inert, a new one in it is not", () => {
    const copied = turn(
      proposalRows([{ id: "a", args: { action: "resume", id: "t" } }], 1_000),
    );
    expect(proposalLines(copied, [], fork)).toEqual([
      {
        key: "proposal:work-1:0",
        kind: "inert",
        action: "resume",
        name: null,
        taskId: "t",
      },
    ]);
    const created = turn(
      proposalRows(
        [{ id: "a", args: { action: "create", name: "cert-expiry-check" } }],
        1_000,
      ),
    );
    expect(proposalLines(created, [], fork)).toEqual([
      {
        key: "proposal:work-1:0",
        kind: "inert",
        action: "create",
        name: "cert-expiry-check",
        taskId: null,
      },
    ]);
    const refused = turn(
      proposalRows(
        [{ id: "a", args: { action: "resume" }, status: "failed" }],
        1_000,
      ),
    );
    expect(proposalLines(refused, [], fork)).toEqual([]);
    const later = turn(
      proposalRows([{ id: "a", args: { action: "resume", id: "t" } }], 6_000),
    );
    expect(proposalLines(later, [], fork)).toEqual([]);
  });
});

describe("the line's words", () => {
  test("pending says the action, decided says how it ended", () => {
    const at = { decidedAt: 2_000 };
    const by = { decidedBy: { id: "u2", username: "robin" }, ...at };
    expect(lineHead(createDraft())).toEqual({
      icon: "clock",
      title: "New task",
      by: null,
      note: null,
    });
    expect(lineHead(taskDraft("update")).title).toBe("Change");
    expect(lineHead(taskDraft("suspend")).icon).toBe("pause");
    expect(lineHead(taskDraft("resume")).icon).toBe("play");
    expect(lineHead(taskDraft("run")).title).toBe("Run now");
    const confirmed = (d: AutomationDraft) =>
      lineHead({ ...d, state: "confirmed", ...by });
    expect(confirmed(createDraft())).toEqual({
      icon: "check",
      title: "Created",
      by: { verb: "confirmed", username: "robin", at: 2_000 },
      note: null,
    });
    expect(confirmed(taskDraft("update")).title).toBe("Changed");
    expect(confirmed(taskDraft("suspend")).title).toBe("Suspended");
    expect(confirmed(taskDraft("resume")).title).toBe("Resumed");
    expect(confirmed(taskDraft("run")).title).toBe("Ran");
    expect(
      lineHead({ ...taskDraft("run"), state: "dismissed", ...by }),
    ).toEqual({
      icon: "bolt",
      title: "Run now",
      by: { verb: "dismissed", username: "robin", at: 2_000 },
      note: null,
    });
    expect(lineHead({ ...createDraft(), state: "stale" }).note).toBe(
      "not applied, the task changed",
    );
    expect(lineHead({ ...createDraft(), state: "expired" }).note).toBe(
      "not applied, expired",
    );
  });

  test("a create says when, an update what it changes, once pending", () => {
    expect(lineDetail(createDraft())).toBe("every day at 09:00");
    const cron = createDraft();
    if (cron.action === "create") cron.fields.schedule = "0 9 1-3 * 1";
    expect(lineDetail(cron)).toBe("0 9 1-3 * 1");
    const once = createDraft();
    if (once.action === "create") once.fields.once = true;
    expect(lineDetail(once)).toBe("once");
    expect(
      lineDetail(
        taskDraft("update", {
          fields: { instructions: "x", schedule: "0 1 * * *" },
        } as Partial<AutomationDraft>),
      ),
    ).toBe("schedule, instructions");
    expect(
      lineDetail(
        taskDraft("update", {
          fields: {
            name: "x",
            ownMemory: true,
            memoryGuidance: "Keep it.",
            attentionGuidance: "Alert.",
          },
        } as Partial<AutomationDraft>),
      ),
    ).toBe("name, memory, attention");
    expect(
      lineDetail(
        taskDraft("update", {
          fields: { attentionGuidance: "" },
        } as Partial<AutomationDraft>),
      ),
    ).toBe("attention");
    expect(lineDetail(taskDraft("run"))).toBeNull();
    expect(lineDetail({ ...createDraft(), state: "confirmed" })).toBeNull();
  });

  test("the name links the task, the created task or the run", () => {
    expect(nameTarget(createDraft(), false)).toBeNull();
    expect(
      nameTarget(
        { ...createDraft(), state: "confirmed", createdAutomationId: "new" },
        false,
      ),
    ).toEqual({ kind: "task", id: "new" });
    expect(nameTarget(taskDraft("suspend"), true)).toEqual({
      kind: "task",
      id: "task-1",
    });
    expect(nameTarget(taskDraft("suspend"), false)).toBeNull();
    expect(
      nameTarget(
        { ...taskDraft("run"), state: "confirmed", runSessionId: "run-1" },
        true,
      ),
    ).toEqual({ kind: "run", id: "run-1" });
  });

  test("only a create or an update opens", () => {
    expect(opens(createDraft())).toBe(true);
    const update = (fields: object) =>
      taskDraft("update", { fields } as Partial<AutomationDraft>);
    expect(opens(update({ name: "x" }))).toBe(true);
    expect(opens(update({ once: true }))).toBe(true);
    for (const action of ["suspend", "resume", "run"] as const) {
      expect(opens(taskDraft(action))).toBe(false);
    }
  });

  test("changed fields strike the task's value where it differs", () => {
    expect(
      changedFields(
        { name: "next", schedule: "0 9 * * *", tz: "UTC" },
        task({ name: "old", schedule: "*/5 * * * *", tz: "UTC" }),
      ),
    ).toEqual([
      { label: "Name", value: "next", was: "old" },
      {
        label: "Schedule",
        value: "every day at 09:00",
        was: "every 5 minutes",
      },
      { label: "Time zone", value: "UTC", was: null },
    ]);
    expect(changedFields({ name: "next" }, null)).toEqual([
      { label: "Name", value: "next", was: null },
    ]);
    expect(changedFields({ once: true }, task({ once: false }))).toEqual([
      { label: "Run once", value: "yes", was: "no" },
    ]);
    expect(
      changedFields({ ownMemory: false }, task({ ownMemory: true })),
    ).toEqual([{ label: "Own memory", value: "no", was: "yes" }]);
    expect(changedFields({ ownMemory: false }, null)).toEqual([
      { label: "Own memory", value: "no", was: null },
    ]);
  });

  test("a create's guidance shows when set, an update's when changed", () => {
    const fields = {
      instructions: "Read the feed.",
      ownMemory: true,
      memoryGuidance: "Keep it.",
      attentionGuidance: "",
    };
    expect(createTexts(fields)).toEqual([
      { label: null, value: "Read the feed." },
      { label: "Memory", value: "Keep it." },
    ]);
    expect(
      createTexts({ ...fields, ownMemory: false, attentionGuidance: "Alert." }),
    ).toEqual([
      { label: null, value: "Read the feed." },
      { label: "Attention", value: "Alert." },
    ]);
    expect(
      updateTexts(
        { attentionGuidance: "Alert.", memoryGuidance: "Keep it." },
        task({ memoryGuidance: "", attentionGuidance: "Old." }),
      ),
    ).toEqual([
      { label: "Memory", value: "Keep it.", was: "" },
      { label: "Attention", value: "Alert.", was: "Old." },
    ]);
    expect(updateTexts({ memoryGuidance: "Keep it." }, null)).toEqual([
      { label: "Memory", value: "Keep it.", was: undefined },
    ]);
  });
});

describe("the decided time", () => {
  test("ticks each second, then slower as it ages", () => {
    expect(agoTickMs(0, 5_000)).toBe(1000);
    expect(agoTickMs(0, 59_999)).toBe(1000);
    expect(agoTickMs(0, 60_000)).toBe(30_000);
    expect(agoTickMs(0, 3_600_000)).toBe(300_000);
  });
});

describe("the instructions as drawn", () => {
  test("the line diff keeps order and marks what changed", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
    expect(lineDiff("a\nb\nc\nd", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
    ]);
    expect(lineDiff("", "x")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "x" },
    ]);
  });

  test("a text set or cleared draws no blank line", () => {
    expect(changedLines("", "a\nb")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
    expect(changedLines("a", "")).toEqual([{ kind: "removed", text: "a" }]);
    expect(changedLines("", "")).toEqual([]);
    expect(changedLines("a\nb", "a\nc")).toEqual([
      { kind: "removed", text: "b" },
      { kind: "added", text: "c" },
    ]);
  });

  test("a long text changed at both ends stays bounded", () => {
    const lines = Array.from({ length: 16_000 }, (_, i) => `step ${i}`);
    const after = [...lines];
    after[0] = "new first";
    after[lines.length - 1] = "new last";
    const start = performance.now();
    const diff = lineDiff(lines.join("\n"), after.join("\n"));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(diff.filter((line) => line.kind === "added")).toHaveLength(16_000);
    expect(diff[0]).toEqual({ kind: "removed", text: "step 0" });
    expect(diff.at(-1)).toEqual({ kind: "added", text: "new last" });
  });

  test("a long text with one changed line diffs only that line", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const after = [...lines];
    after[10_000] = "changed";
    const changed = lineDiff(lines.join("\n"), after.join("\n")).filter(
      (line) => line.kind !== "same",
    );
    expect(changed).toEqual([
      { kind: "removed", text: "line 10000" },
      { kind: "added", text: "changed" },
    ]);
  });

  test("bidi and zero-width characters become visible marks", () => {
    expect(visibleParts("pay‮evil​!")).toEqual([
      { mark: false, text: "pay" },
      { mark: true, text: "U+202E" },
      { mark: false, text: "evil" },
      { mark: true, text: "U+200B" },
      { mark: false, text: "!" },
    ]);
    expect(visibleParts("plain")).toEqual([{ mark: false, text: "plain" }]);
  });

  test("an emoji's own joiners and flag tags are not marked", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const coder = "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
    const flag = (code: string) => `\u{1F3F4}${tag(code)}\u{E007F}`;
    for (const emoji of [
      family,
      coder,
      flag("gbeng"),
      flag("gbsct"),
      flag("gbwls"),
    ]) {
      expect(visibleParts(`a ${emoji} b`)).toEqual([
        { mark: false, text: `a ${emoji} b` },
      ]);
    }
    // a joiner between letters, and tags anywhere else, still are
    expect(visibleParts("a\u200Db")[1]).toEqual({
      mark: true,
      text: "U+200D",
    });
    const bare = visibleParts("x\u{E0067}\u{E0062}\u{E007F}");
    expect(bare.filter((part) => part.mark)).toHaveLength(3);
  });

  test("tags behind a flag that is not a listed one are marked", () => {
    const marks = (text: string) =>
      visibleParts(text).filter((part) => part.mark).length;
    // hidden ASCII dressed as a flag
    expect(marks(`\u{1F3F4}${tag("rm -rf ~/")}\u{E007F}`)).toBe(10);
    // a real flag's tags with more after them
    expect(marks(`\u{1F3F4}${tag("gbsctx")}\u{E007F}`)).toBe(7);
    // five chained flags of hidden text
    const chained = `\u{1F3F4}${tag("ignore pre")}\u{E007F}`.repeat(5);
    expect(marks(chained)).toBe(55);
    expect(marks(`\u{1F3F4}${tag("usca")}\u{E007F}`)).toBe(5);
  });

  test("tag characters smuggling ASCII and blank fillers are marked", () => {
    const tags = [..."rm"].map((c) =>
      String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)),
    );
    expect(visibleParts(`ok${tags.join("")}.`)).toEqual([
      { mark: false, text: "ok" },
      { mark: true, text: "U+E0072" },
      { mark: true, text: "U+E006D" },
      { mark: false, text: "." },
    ]);
    for (const code of [
      0x00ad, 0x034f, 0x180e, 0x115f, 0x3164, 0xffa0, 0x2028, 0xfff9, 0xe0001,
      0xe0100,
    ]) {
      const parts = visibleParts(`a${String.fromCodePoint(code)}b`);
      expect(parts[1]).toEqual({
        mark: true,
        text: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      });
    }
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const settle = () => new Promise((r) => setTimeout(r, 0));

// the inside of the row: from its opening tag to the details after it
const rowOf = (html: string) =>
  html.slice(html.indexOf('class="proposal-row"'), html.lastIndexOf("</div>"));

describe("the line", () => {
  test("a pending create has a chevron and both buttons in its row", () => {
    const html = render(
      <Proposal line={{ key: "k", kind: "draft", draft: createDraft() }} />,
    );
    expect(html).toContain("New task");
    expect(html).toContain("daily-digest");
    expect(html).toContain("every day at 09:00");
    expect(html).toContain('aria-label="Show details"');
    const row = rowOf(html);
    expect(row).toContain(">Dismiss</button>");
    expect(row).toContain(">Confirm</button>");
    expect(row).toContain("proposal-confirm");
  });

  test("each decided state says how it ended, without buttons", () => {
    const by = { decidedBy: { id: "u2", username: "robin" }, decidedAt: 1 };
    const draw = (draft: AutomationDraft) =>
      render(<Proposal line={{ key: "k", kind: "draft", draft }} />);
    const created = draw({
      ...createDraft(),
      state: "confirmed",
      createdAutomationId: "new-task",
      ...by,
    });
    expect(created).toContain("Created");
    expect(created).toContain('href="/automations/new-task"');
    expect(created).toContain("confirmed by");
    expect(created).toContain("@robin");
    expect(created).not.toContain("Confirm</button>");
    expect(created).not.toContain("every day at 09:00");
    const dismissed = draw({ ...createDraft(), state: "dismissed", ...by });
    expect(dismissed).toContain("dismissed by");
    expect(draw({ ...createDraft(), state: "stale" })).toContain(
      "not applied, the task changed",
    );
    expect(draw({ ...createDraft(), state: "expired" })).toContain(
      "not applied, expired",
    );
  });

  test("a fork's line is inert: its name, no buttons and no chevron", () => {
    const html = render(
      <Proposal
        line={{
          key: "k",
          kind: "inert",
          action: "create",
          name: "cert-expiry-check",
          taskId: null,
        }}
      />,
    );
    expect(html).toContain("New task");
    expect(html).toContain(
      '<span class="proposal-name">cert-expiry-check</span>',
    );
    expect(html).toContain(INERT_WORDS);
    expect(html).not.toContain("<button");
  });

  test.serial(
    "a fork's line on a task names it, or a deleted task once it is gone",
    async () => {
      globalThis.fetch = (async (url: string) =>
        String(url).endsWith("/gone-task")
          ? Response.json({ error: "no" }, { status: 404 })
          : Response.json({
              automation: task({ id: "fork-task" }),
            })) as unknown as typeof fetch;
      await loadDraftTask("fork-task");
      await loadDraftTask("gone-task");
      const draw = (taskId: string) =>
        render(
          <Proposal
            line={{
              key: "k",
              kind: "inert",
              action: "suspend",
              name: null,
              taskId,
            }}
          />,
        );
      expect(draw("fork-task")).toContain(
        '<a class="proposal-name" href="/automations/fork-task">nightly-check</a>',
      );
      const gone = draw("gone-task");
      expect(gone).toContain(
        '<span class="proposal-name">a deleted task</span>',
      );
      expect(gone).toContain(INERT_WORDS);
    },
  );

  test.serial(
    "a line on a task waits for it, then only an update has a chevron",
    async () => {
      globalThis.fetch = (async () =>
        Response.json({ automation: task() })) as unknown as typeof fetch;
      loadDraftTask("task-1");
      await settle();
      const draw = (draft: AutomationDraft) =>
        render(<Proposal line={{ key: "k", kind: "draft", draft }} />);
      const update = draw(
        taskDraft("update", {
          fields: { schedule: "0 9 * * *" },
        } as Partial<AutomationDraft>),
      );
      expect(update).toContain("nightly-check");
      expect(update).toContain('href="/automations/task-1"');
      expect(update).toContain("schedule");
      expect(update).toContain('aria-label="Show details"');
      for (const action of ["suspend", "resume", "run"] as const) {
        const html = draw(taskDraft(action));
        expect(html).toContain("nightly-check");
        expect(html).not.toContain("Show details");
        expect(rowOf(html)).toContain(">Confirm</button>");
      }
      const ran = draw({
        ...taskDraft("run"),
        state: "confirmed",
        runSessionId: "run-1",
        decidedBy: { id: "u2", username: "robin" },
        decidedAt: 1,
      });
      expect(ran).toContain("Ran");
      expect(ran).toContain('href="/run/run-1"');
      const rename = taskDraft("update", {
        fields: { name: "renamed" },
      } as Partial<AutomationDraft>);
      const pending = draw(rename);
      expect(pending).toContain(
        '<a class="proposal-name" href="/automations/task-1">nightly-check</a>',
      );
      expect(pending).not.toContain("renamed");
      const confirmed = draw({
        ...rename,
        state: "confirmed",
        decidedBy: { id: "u2", username: "robin" },
        decidedAt: 1,
      });
      expect(confirmed).toContain(">renamed</a>");
    },
  );
});

describe("a line whose task read fails", () => {
  test.serial(
    "names the task, keeps both buttons and opens nothing, then a delete names it gone",
    async () => {
      globalThis.fetch = (async () =>
        Response.json(
          { error: "down" },
          { status: 502 },
        )) as unknown as typeof fetch;
      await loadDraftTask("t-fail");
      const update = taskDraft("update", {
        automationId: "t-fail",
        fields: { instructions: "new" },
      } as Partial<AutomationDraft>);
      const drawn = render(
        <Proposal line={{ key: "k", kind: "draft", draft: update }} />,
      );
      expect(drawn).toContain('<span class="proposal-name">the task</span>');
      expect(rowOf(drawn)).toContain(">Dismiss</button>");
      expect(rowOf(drawn)).toContain(">Confirm</button>");
      expect(drawn).not.toContain("Show details");
      const inert = (
        <Proposal
          line={{
            key: "k",
            kind: "inert",
            action: "suspend",
            name: null,
            taskId: "t-fail",
          }}
        />
      );
      expect(render(inert)).toContain(
        '<span class="proposal-name">the task</span>',
      );
      onSocket({
        type: "automationDeleted",
        automationId: "t-fail",
        projectId: "p1",
        runs: false,
      });
      expect(taskFailing("t-fail")).toBe(false);
      expect(render(inert)).toContain(
        '<span class="proposal-name">a deleted task</span>',
      );
      expect(
        render(<Proposal line={{ key: "k", kind: "draft", draft: update }} />),
      ).toContain('<span class="proposal-name">a deleted task</span>');
    },
  );
});

describe("an opened line", () => {
  test("a create shows its whole instructions with marks", () => {
    const draft = createDraft();
    if (draft.action === "create") draft.fields.instructions = "pay\u202Eme";
    const html = render(<Details draft={draft} before={null} />);
    expect(html).toContain("proposal-text");
    expect(html).toContain(
      '<span class="proposal-mark" title="Invisible character">U+202E</span>',
    );
  });

  test("an update strikes old values and shows only changed lines", () => {
    const draft = taskDraft("update", {
      fields: {
        name: "renamed",
        instructions: "Check the queue.\nReport every failure.",
      },
    } as Partial<AutomationDraft>);
    const html = render(<Details draft={draft} before={task()} />);
    expect(html).toContain('<span class="proposal-was">nightly-check</span>');
    expect(html).toContain('<span class="proposal-value">renamed</span>');
    expect(html).toContain("proposal-removed");
    expect(html).toContain("Report failures.");
    expect(html).toContain("proposal-added");
    expect(html).not.toContain("Check the queue.");
  });

  test("a create shows its guidance under the instructions, or No memory", () => {
    const draft = createDraft();
    if (draft.action === "create") {
      draft.fields.memoryGuidance = "Keep failing sources.";
      draft.fields.attentionGuidance = "A price moved.";
    }
    const html = render(<Details draft={draft} before={null} />);
    expect(html.indexOf("Write a digest.")).toBeLessThan(
      html.indexOf('<span class="proposal-label">Memory</span>'),
    );
    expect(html).toContain("Keep failing sources.");
    expect(html).toContain('<span class="proposal-label">Attention</span>');
    expect(html).toContain("A price moved.");
    expect(html).not.toContain("No memory");
    if (draft.action === "create") {
      draft.fields.ownMemory = false;
      draft.fields.memoryGuidance = "";
      draft.fields.attentionGuidance = "";
    }
    const none = render(<Details draft={draft} before={null} />);
    expect(none).toContain('<p class="proposal-note">No memory</p>');
    expect(none).not.toContain("proposal-label");
  });

  test("a long text is cut with Show all and opens whole", () => {
    const value = Array.from(
      { length: CUT_LINES + 1 },
      (_, i) => `line ${i}`,
    ).join("\n");
    const block = { label: "Memory", value };
    const fold = (open: boolean, long = false) =>
      render(
        <TextFold block={block} open={open} long={long} onOpen={() => {}} />,
      );
    const cut = fold(false);
    expect(cut).toContain("proposal-clip");
    expect(cut).toContain(
      '<button type="button" class="btn-text">Show all</button>',
    );
    expect(cut).toContain("fold-inset");
    const whole = fold(true);
    expect(whole).not.toContain("proposal-clip");
    expect(whole).not.toContain("Show all");
    expect(whole).toContain(`line ${CUT_LINES}`);
    // a short text is cut only once the measure says it hides something
    const short = { label: null, value: "one line" };
    expect(
      render(
        <TextFold block={short} open={false} long={false} onOpen={() => {}} />,
      ),
    ).not.toContain("Show all");
    expect(
      render(<TextFold block={short} open={false} long onOpen={() => {}} />),
    ).toContain("Show all");
    // the changed lines of a diff are what the count cuts
    const diff = render(
      <TextFold
        block={{ label: null, value: `${value}\nnew`, was: value }}
        open={false}
        long={false}
        onOpen={() => {}}
      />,
    );
    expect(diff).toContain("proposal-added");
    expect(diff).not.toContain("Show all");
  });

  test("a guidance cleared on an unread task says None, not an empty box", () => {
    const draft = taskDraft("update", {
      fields: { attentionGuidance: "" },
    } as Partial<AutomationDraft>);
    const html = render(<Details draft={draft} before={null} />);
    expect(html).toContain('<span class="proposal-label">Attention</span>');
    expect(html).toContain('<p class="proposal-note">None</p>');
    expect(html).not.toContain("proposal-text");
  });

  test("an update draws each changed guidance as it draws instructions", () => {
    const draft = taskDraft("update", {
      fields: {
        ownMemory: true,
        memoryGuidance: "Keep failing sources.",
        attentionGuidance: "Only outages.\nA script failed.",
      },
    } as Partial<AutomationDraft>);
    const html = render(
      <Details
        draft={draft}
        before={task({
          ownMemory: false,
          memoryGuidance: "Keep everything.",
          attentionGuidance: "Only outages.\nAny error.",
        })}
      />,
    );
    expect(html).toContain('<span class="proposal-label">Own memory</span>');
    expect(html).toContain('<span class="proposal-was">no</span>');
    expect(html).toContain('<span class="proposal-label">Memory</span>');
    expect(html).toContain('<span class="proposal-label">Attention</span>');
    for (const [kind, text] of [
      ["removed", "Keep everything."],
      ["added", "Keep failing sources."],
      ["removed", "Any error."],
      ["added", "A script failed."],
    ]) {
      expect(html).toContain(
        `<div class="proposal-diff proposal-${kind}">${text}</div>`,
      );
    }
    expect(html).not.toContain("Only outages.");
  });
});
