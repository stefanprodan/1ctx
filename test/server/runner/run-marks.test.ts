// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's own mark: attention is never offered in the main rounds,
// only alone in the attention step after a finished run, whose verdict
// is written with the run's end, a true one alone marking; the runner marks a failure, a deadline and
// a spent budget with no model. The step has two rounds at most, refuses
// any other tool, and its failure, its window or a Stop marks nothing and
// never fails the run. An automation whose mode is off has no step.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  ATTENTION_AGAIN,
  ATTENTION_ASK,
  attentionSystem,
} from "../../../src/server/runner/attention-packet.ts";
import {
  ATTENTION_MAX_TOKENS,
  ATTENTION_STEP_MS,
} from "../../../src/server/runner/attention-step.ts";
import {
  DEADLINE_REASON,
  LIMIT_REASON,
} from "../../../src/server/runner/marks.ts";
import { memorySystem } from "../../../src/server/runner/memory-packet.ts";
import { ATTENTION_DESCRIPTION } from "../../../src/server/tools/builtin/attention.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  answerRun,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  setLimits,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

const tools = (script: Script) =>
  (
    (script.body.tools ?? []) as {
      function: { name: string; description: string };
    }[]
  ).map((tool) => tool.function);

const names = (script: Script) => tools(script).map((tool) => tool.name);

const messages = (script: Script) =>
  script.body.messages as { role: string; content: string | null }[];

const flag = (reason: unknown, id = "c1", name = "attention") => ({
  id,
  name,
  arguments: JSON.stringify({ needed: true, reason }),
});

// needed false, with a reason that must never be kept
const clear = (id = "c1") => ({
  id,
  name: "attention",
  arguments: JSON.stringify({ needed: false, reason: "No proposals deleted" }),
});

// a step round of calls, closed
const calling =
  (...calls: { id: string; name: string; arguments: string }[]) =>
  (script: Script) => {
    script.toolRound(calls);
    script.end();
  };

const markOf = (chat: ChatApp, id: string) =>
  chat.app.db
    .query<
      {
        attention: number | null;
        attention_by: string | null;
        attention_reason: string | null;
        attention_source: string | null;
      },
      [string]
    >(
      "select attention, attention_by, attention_reason, attention_source from sessions where id = ?",
    )
    .get(id);

const NONE = {
  attention: null,
  attention_by: null,
  attention_reason: null,
  attention_source: null,
};

const AGENT = (reason: string) => ({
  attention: 1,
  attention_by: "coder",
  attention_reason: reason,
  attention_source: "agent",
});

const agentMode = (chat: ChatApp, fields = {}) =>
  createAutomation(chat, { attentionMode: "agent", ...fields });

describe("the main rounds", () => {
  test("never offer attention, in a run, a chat or the memory phase", async () => {
    const chat = await chatApp();
    try {
      const started = await startChat(chat);
      expect(names(started.script)).not.toContain("attention");
      started.script.reply("hello");
      await settleRun(chat, started.sessionId);

      const own = await agentMode(chat, { ownMemory: true });
      const run = await startRun(chat, own.id);
      expect(names(run.main)).not.toContain("attention");
      expect(JSON.stringify(run.main.body.messages)).not.toContain("attention");
      const step = await answerRun(chat, run.main, "All good.");
      expect(names(step)).toEqual(["attention"]);
      const phase = await waitScript(chat.scripted, 4);
      expect(names(phase)).toEqual(["memory_edit"]);
      phase.reply("Nothing to keep.");
      await settleRun(chat, run.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the attention step", () => {
  test("asks the run's model alone over the record, with the automation's words", async () => {
    const chat = await chatApp();
    try {
      const plain = await agentMode(chat);
      const run = await startRun(chat, plain.id);
      const step = await answerRun(chat, run.main, "All good.");
      expect(step.body.model).toBe(run.main.body.model);
      expect(step.body.max_tokens).toBe(ATTENTION_MAX_TOKENS);
      // the run thinks, the step does not
      expect(run.main.body.enable_thinking).toBe(true);
      expect(step.body.enable_thinking).toBe(false);
      expect(step.body.reasoning_effort).toBeUndefined();
      expect(tools(step)).toEqual([
        expect.objectContaining({
          name: "attention",
          description: ATTENTION_DESCRIPTION,
        }),
      ]);
      const [system, user, ...rest] = messages(step);
      expect(rest).toEqual([]);
      expect(system).toEqual({
        role: "system",
        content: attentionSystem("daily-run"),
      });
      expect(user?.content).toContain("<task>\ncheck the system\n</task>");
      expect(user?.content).toContain("<answer>\nAll good.\n</answer>");
      expect(user?.content).toEndWith(
        `${ATTENTION_ASK}\n\nWhen it does not, call attention with needed false.`,
      );
      expect(user?.content).not.toContain("memory_edit");
      await settleRun(chat, run.sessionId);
      expect(markOf(chat, run.sessionId)).toEqual(NONE);

      const guided = await agentMode(chat, {
        name: "guided",
        attentionGuidance: "Only when Flux is behind the latest release.",
      });
      const other = await startRun(chat, guided.id);
      const asked = await answerRun(chat, other.main, "All good.");
      expect(messages(asked)[1]?.content).toEndWith(
        `${ATTENTION_ASK} When it needs attention: Only when Flux is behind the latest release.\n\nWhen it does not, call attention with needed false.`,
      );
      await settleRun(chat, other.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "a call marks the run as the agent's in the run's one ending envelope",
    async () => {
      const chat = await chatApp();
      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      try {
        const automation = await agentMode(chat);
        const run = await startRun(chat, automation.id);
        await answerRun(
          chat,
          run.main,
          "Three objects are failing.",
          calling(flag("podinfo is not ready")),
        );
        expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
        expect(chat.scripted.scripts).toHaveLength(2);
        const rows = chat.app.sessions.messages(run.sessionId);
        const tool = rows.find((row) => row.kind === "tool");
        expect(tool).toMatchObject({
          toolName: "attention",
          content: "Marked.",
          round: 2,
        });
        expect(rows.find((row) => row.slot === "answer")?.content).toBe(
          "Three objects are failing.",
        );
        expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
          memoryRound: 2,
          attentionRound: 2,
          memoryFrom: null,
          status: "done",
          cause: "finish",
        });
        expect(markOf(chat, run.sessionId)).toEqual(
          AGENT("podinfo is not ready"),
        );
        const ended = events.filter(
          (event) =>
            event.type === "session.changed" &&
            event.data.session.id === run.sessionId &&
            event.data.session.status === "done",
        );
        expect(ended).toHaveLength(1);
        expect(ended[0]).toMatchObject({
          data: {
            session: {
              attention: 1,
              attentionReason: "podinfo is not ready",
              attentionSource: "agent",
            },
          },
        });
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );

  test("a model that must think is asked at the least effort", async () => {
    const chat = await chatApp();
    try {
      const plain = await agentMode(chat);
      chat.app.db.run("update agents set thinking_required = 1");
      const run = await startRun(chat, plain.id);
      expect(run.main.body.enable_thinking).toBe(true);
      const step = await answerRun(chat, run.main, "All good.");
      expect(step.body.enable_thinking).toBe(true);
      expect(step.body.reasoning_effort).toBe("low");
      await settleRun(chat, run.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("needed false marks nothing, drops its reason and keeps its rows after the answer", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(chat, run.main, "All good.", calling(clear()));
      const settled = await settleRun(chat, run.sessionId);
      expect(settled?.status).toBe("done");
      expect(chat.scripted.scripts).toHaveLength(2);
      expect(markOf(chat, run.sessionId)).toEqual(NONE);
      expect(settled).toMatchObject({
        attention: null,
        attentionReason: null,
      });
      const step = chat.app.sessions
        .messages(run.sessionId)
        .filter((row) => row.round === 2);
      expect(step).toMatchObject([
        { kind: "reply", slot: "work", status: "done" },
        {
          kind: "tool",
          toolName: "attention",
          content: "Checked.",
          status: "done",
        },
      ]);
      expect(
        chat.app.db
          .query<{ n: number }, [string]>(
            "select count(*) as n from sessions where attention_reason like ?",
          )
          .get("%No proposals%")?.n,
      ).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the last valid verdict of the step holds", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const cleared = await startRun(chat, automation.id);
      await answerRun(
        chat,
        cleared.main,
        "Flux is failing.",
        calling(flag("flux-system is not ready"), clear("c2")),
      );
      await settleRun(chat, cleared.sessionId);
      expect(markOf(chat, cleared.sessionId)).toEqual(NONE);

      const marked = await startRun(chat, automation.id);
      await answerRun(
        chat,
        marked.main,
        "Flux is failing.",
        calling(clear(), flag("flux-system is not ready", "c2")),
      );
      await settleRun(chat, marked.sessionId);
      expect(markOf(chat, marked.sessionId)).toEqual(
        AGENT("flux-system is not ready"),
      );

      // a refused call after a valid verdict leaves it and ends the step
      const kept = await startRun(chat, automation.id);
      await answerRun(
        chat,
        kept.main,
        "Flux is failing.",
        calling(flag("flux-system is not ready"), flag("", "c2")),
      );
      await settleRun(chat, kept.sessionId);
      expect(markOf(chat, kept.sessionId)).toEqual(
        AGENT("flux-system is not ready"),
      );

      // a round that failed, then needed false in the second
      const late = await startRun(chat, automation.id);
      await answerRun(chat, late.main, "Flux is failing.", calling(flag("")));
      const again = await waitScript(
        chat.scripted,
        chat.scripted.scripts.length + 1,
      );
      calling(clear("c2"))(again);
      await settleRun(chat, late.sessionId);
      expect(markOf(chat, late.sessionId)).toEqual(NONE);
      // 2 requests each for the first three runs, 3 for the last
      expect(chat.scripted.scripts).toHaveLength(9);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a bad needed or a missing reason is written again", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(
        chat,
        run.main,
        "Flux is failing.",
        calling(
          { id: "c1", name: "attention", arguments: '{"needed":"yes"}' },
          { id: "c2", name: "attention", arguments: '{"needed":true}' },
        ),
      );
      const again = await waitScript(chat.scripted, 3);
      expect(messages(again).slice(2)).toEqual([
        expect.objectContaining({ role: "assistant" }),
        {
          role: "tool",
          tool_call_id: "c1",
          content: "Error: needed must be true or false.",
        },
        {
          role: "tool",
          tool_call_id: "c2",
          content: "Error: needed true takes a one-line reason.",
        },
      ]);
      calling(flag("flux-system is not ready", "c3"))(again);
      await settleRun(chat, run.sessionId);
      expect(markOf(chat, run.sessionId)).toEqual(
        AGENT("flux-system is not ready"),
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a refused reason is written again once, and only once", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const fixed = await startRun(chat, automation.id);
      await answerRun(
        chat,
        fixed.main,
        "Flux is failing.",
        calling(flag("placeholder-not-called")),
      );
      const again = await waitScript(chat.scripted, 3);
      expect(names(again)).toEqual(["attention"]);
      expect(messages(again).slice(2)).toEqual([
        expect.objectContaining({ role: "assistant" }),
        {
          role: "tool",
          tool_call_id: "c1",
          content:
            "Error: reason must say what a user should act on, not a placeholder.",
        },
      ]);
      calling(flag("flux-system is not ready", "c2"))(again);
      await settleRun(chat, fixed.sessionId);
      expect(markOf(chat, fixed.sessionId)).toEqual(
        AGENT("flux-system is not ready"),
      );

      const twice = await startRun(chat, automation.id);
      await answerRun(chat, twice.main, "Flux is failing.", calling(flag("")));
      const last = await waitScript(chat.scripted, 6);
      calling(flag("first line\nsecond line", "c2"))(last);
      expect((await settleRun(chat, twice.sessionId))?.status).toBe("done");
      expect(chat.scripted.scripts).toHaveLength(6);
      expect(markOf(chat, twice.sessionId)).toEqual(NONE);
      const refused = chat.app.sessions
        .messages(twice.sessionId)
        .filter((row) => row.kind === "tool");
      expect(refused.map((row) => [row.round, row.status])).toEqual([
        [2, "failed"],
        [3, "failed"],
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a reply that writes the call out as text is asked again, and the call marks", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      const first = await answerRun(
        chat,
        run.main,
        "Payments is down.",
        (step) =>
          step.reply(
            "attention: Payments service is unhealthy, 0 of 3 pods Ready",
          ),
      );
      expect(messages(first)).toHaveLength(2);
      const again = await waitScript(chat.scripted, 3);
      expect(names(again)).toEqual(["attention"]);
      expect(messages(again).slice(2)).toEqual([
        expect.objectContaining({
          role: "assistant",
          content:
            "attention: Payments service is unhealthy, 0 of 3 pods Ready",
        }),
        { role: "user", content: ATTENTION_AGAIN },
      ]);
      calling(flag("payments: 0 of 3 pods Ready"))(again);
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(markOf(chat, run.sessionId)).toEqual(
        AGENT("payments: 0 of 3 pods Ready"),
      );
      expect(
        chat.app.sessions
          .messages(run.sessionId)
          .filter((row) => row.round >= 2)
          .map((row) => [row.round, row.kind, row.status]),
      ).toEqual([
        [2, "reply", "done"],
        [3, "reply", "done"],
        [3, "tool", "done"],
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("text twice marks nothing, and text is never read for a mark", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(chat, run.main, "Payments is down.", (step) =>
        step.reply("attention: Payments service is unhealthy"),
      );
      const again = await waitScript(chat.scripted, 3);
      again.reply("attention: Payments service is unhealthy");
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(chat.scripted.scripts).toHaveLength(3);
      expect(markOf(chat, run.sessionId)).toEqual(NONE);

      // "ok" is no answer: it is asked again, and a verdict ends it
      const ok = await startRun(chat, automation.id);
      await answerRun(chat, ok.main, "All good.", (step) => step.reply("OK."));
      const verdict = await waitScript(chat.scripted, 6);
      expect(messages(verdict).at(-1)).toEqual({
        role: "user",
        content: ATTENTION_AGAIN,
      });
      calling(clear())(verdict);
      expect((await settleRun(chat, ok.sessionId))?.status).toBe("done");
      expect(chat.scripted.scripts).toHaveLength(6);
      expect(markOf(chat, ok.sessionId)).toEqual(NONE);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses any other tool and keeps the last good reason of a round", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(
        chat,
        run.main,
        "Flux is failing.",
        calling(
          flag("ignored", "c1", "bash"),
          flag("first look", "c2"),
          flag("podinfo and flux-system are failing", "c3"),
        ),
      );
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      const rows = chat.app.sessions
        .messages(run.sessionId)
        .filter((row) => row.kind === "tool");
      expect(rows.map((row) => [row.toolName, row.status])).toEqual([
        ["bash", "failed"],
        ["attention", "done"],
        ["attention", "done"],
      ]);
      expect(rows[0]?.error).toBe(
        "Error: only attention is offered in this step.",
      );
      expect(markOf(chat, run.sessionId)?.attention_reason).toBe(
        "podinfo and flux-system are failing",
      );
      expect(chat.scripted.scripts).toHaveLength(2);
      expect(
        logs.events.find((event) => event.msg === "tool failed")?.fields,
      ).toMatchObject({ tool: "bash", error_type: "ToolError" });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a failure of it marks nothing, is logged without words and never fails the run", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      const before = chat.scripted.chats();
      chat.scripted.refuse(400, "no such model", { times: 1 });
      run.main.reply("Flux is failing.");
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(chat.scripted.chats()).toBe(before + 1);
      expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
        status: "done",
        cause: "finish",
        error: null,
      });
      expect(markOf(chat, run.sessionId)).toEqual(NONE);
      const failed = logs.events.filter(
        (event) => event.msg === "attention step failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ area: "runner", level: "warn" });
      expect(JSON.stringify(failed[0]!.fields)).not.toContain("no such model");
      expect(JSON.stringify(failed[0]!.fields)).not.toContain("Flux");
      const row = chat.app.sessions
        .messages(run.sessionId)
        .find((message) => message.round === 2);
      expect(row?.status).toBe("failed");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("its window running out marks nothing and ends the run", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(chat, run.main, "Flux is failing.", (step) => {
        step.toolCall({
          index: 0,
          id: "c1",
          name: "attention",
          arguments: "",
        });
      });
      chat.app.now.value += ATTENTION_STEP_MS;
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(markOf(chat, run.sessionId)).toEqual(NONE);
      expect(
        logs.events.filter((event) => event.msg === "attention step failed"),
      ).toEqual([expect.objectContaining({ fields: expect.anything() })]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a Stop during it marks nothing and skips the memory phase", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat, { ownMemory: true });
      const run = await startRun(chat, automation.id);
      const step = await answerRun(
        chat,
        run.main,
        "Flux is failing.",
        () => {},
      );
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/stop`,
      );
      expect(stop.status).toBe(200);
      await settleRun(chat, run.sessionId);
      expect(step.aborted).toBeTrue();
      expect(chat.scripted.scripts).toHaveLength(2);
      expect(markOf(chat, run.sessionId)).toEqual(NONE);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("runs before the memory phase, whose record leaves the step out, and counts its usage", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat, { ownMemory: true });
      const run = await startRun(chat, automation.id);
      await answerRun(
        chat,
        run.main,
        "Flux is failing.",
        calling(flag("flux-system is not ready")),
      );
      const phase = await waitScript(chat.scripted, 3);
      expect(messages(phase)[0]?.content).toBe(memorySystem("daily-run"));
      expect(JSON.stringify(phase.body.messages)).not.toContain("attention");
      phase.reply("Nothing to keep.");
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(markOf(chat, run.sessionId)).toEqual(
        AGENT("flux-system is not ready"),
      );
      const send = chat.app.sessions.lastSend(run.sessionId)!;
      expect(send).toMatchObject({
        memoryRound: 2,
        attentionRound: 2,
        memoryFrom: 3,
        rounds: 3,
      });
      expect(
        chat.app.sessions
          .messages(run.sessionId)
          .filter((row) => row.kind === "reply")
          .map((row) => [row.round, row.slot]),
      ).toEqual([
        [1, "answer"],
        [2, "work"],
        [3, "work"],
      ]);
      expect(
        chat.app.db
          .query<{ round: number }, [string]>(
            "select round from usage where send_id = ? order by round",
          )
          .all(send.id)
          .map((row) => row.round),
      ).toEqual([1, 2, 3]);
      expect(send.tokens).toBe(45);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("is not asked in the off mode, of a chat, or by a model without tools", async () => {
    const chat = await chatApp();
    try {
      const off = await createAutomation(chat, { attentionMode: "off" });
      const run = await startRun(chat, off.id);
      run.main.reply("All good.");
      await settleRun(chat, run.sessionId);
      expect(chat.scripted.scripts).toHaveLength(1);
      expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
        memoryRound: null,
        attentionRound: null,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a fork of a marked run carries no mark and none of the step", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const run = await startRun(chat, automation.id);
      await answerRun(chat, run.main, "Down.", calling(flag("not ready")));
      await settleRun(chat, run.sessionId);
      const answer = chat.app.sessions
        .messages(run.sessionId)
        .find((row) => row.slot === "answer")!;
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/fork`,
        { body: { messageId: answer.id, agentId: chat.agentId } },
      );
      expect(forked.status).toBe(201);
      const fork = (await forked.json()).session;
      expect(fork).toMatchObject({
        attention: null,
        attentionReason: null,
        attentionSource: null,
        attentionBy: null,
      });
      expect(markOf(chat, fork.id)).toEqual(NONE);
      expect(
        chat.app.sessions.messages(fork.id).some((row) => row.kind === "tool"),
      ).toBeFalse();
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the runner marks, with no step", () => {
  test("a failed run, a run past its deadline and a spent budget", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const failed = await startRun(chat, automation.id);
      failed.main.content("half");
      failed.main.end();
      expect((await settleRun(chat, failed.sessionId))?.status).toBe("failed");
      expect(markOf(chat, failed.sessionId)).toEqual({
        attention: 1,
        attention_by: null,
        attention_reason: "The run failed: stream ended early",
        attention_source: "runner",
      });

      const late = await startRun(chat, automation.id);
      chat.app.now.value += 600_000;
      expect((await settleRun(chat, late.sessionId))?.status).toBe("stopped");
      expect(markOf(chat, late.sessionId)?.attention_reason).toBe(
        DEADLINE_REASON,
      );

      await setLimits(chat, { rounds: 2 });
      const spent = await startRun(chat, automation.id);
      spent.main.toolRound([{ id: "t1", name: "datetime", arguments: "{}" }]);
      spent.main.end();
      const answer = await waitScript(
        chat.scripted,
        chat.scripted.scripts.length + 1,
      );
      answer.reply("Out of rounds.");
      expect((await settleRun(chat, spent.sessionId))?.status).toBe("done");
      expect(markOf(chat, spent.sessionId)?.attention_reason).toBe(
        LIMIT_REASON,
      );
      // no step after any of them: two requests for the spent run alone
      expect(chat.scripted.scripts).toHaveLength(4);
      expect(chat.app.sessions.lastSend(spent.sessionId)?.attentionRound).toBe(
        null,
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("nothing for a stop or an automation set to off", async () => {
    const chat = await chatApp();
    try {
      const automation = await agentMode(chat);
      const stopped = await startRun(chat, automation.id);
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${stopped.sessionId}/stop`,
      );
      expect(stop.status).toBe(200);
      expect((await settleRun(chat, stopped.sessionId))?.status).toBe(
        "stopped",
      );
      expect(markOf(chat, stopped.sessionId)).toEqual(NONE);

      const off = await createAutomation(chat, {
        name: "off",
        attentionMode: "off",
      });
      const failed = await startRun(chat, off.id);
      failed.main.content("half");
      failed.main.end();
      expect((await settleRun(chat, failed.sessionId))?.status).toBe("failed");
      expect(markOf(chat, failed.sessionId)).toEqual(NONE);
    } finally {
      await chat.app.shutdown();
    }
  });
});
