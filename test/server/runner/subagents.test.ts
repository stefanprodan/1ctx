// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// delegate end to end: who is offered it, the child's prompt, offer and
// rows, what comes back, its usage, and how the parent's end ends it.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { SUBAGENT_LINE } from "../../../src/server/runner/prompt.ts";
import { testApp } from "../../helpers/app.ts";
import { createAutomation, startRun } from "../../helpers/automations.ts";
import {
  chatApp,
  NO_TOOLS,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import {
  allowSubagents,
  childrenOf,
  delegateCall,
  delegateRows,
  isChild,
  lastResult,
  scratchLeft,
  settled,
  subagentApp,
  system,
  toolNames,
  wire,
} from "../../helpers/subagents.ts";

describe("who is offered delegate", () => {
  test("only an agent with the switch on, on a model that takes tools", async () => {
    const chat = await chatApp();
    try {
      const off = await startChat(chat);
      expect(toolNames(off.script)).not.toContain("delegate");
      off.script.reply("done");
      await settled(chat, off.sessionId);
      allowSubagents(chat, chat.agentId);
      const on = await startChat(chat);
      expect(toolNames(on.script)).toContain("delegate");
      on.script.reply("done");
      await settled(chat, on.sessionId);
      const bare = await chat.makeAgent({ name: "bare", model: NO_TOOLS });
      allowSubagents(chat, bare);
      const none = await startChat(
        chat,
        "hi",
        chat.member,
        chat.projectId,
        bare,
      );
      expect(none.script.body.tools).toBeUndefined();
      expect(
        chat.app.runner.registry.get(none.sessionId)?.policy.childOffered,
      ).toBeNull();
      none.script.reply("done");
      await settled(chat, none.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a delegated task", () => {
  test("runs in a hidden child on its own prompt and offer, and answers the parent", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat, "survey the repo");
      script.toolRound([delegateCall("d1", "List the files under /repos.")], {
        prompt: 100,
        completion: 10,
      });
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      expect(system(child)).not.toContain("You talk to");
      expect(system(child)).not.toContain("knowledge base");
      expect(wire(child).slice(1)).toEqual([
        {
          role: "user",
          content: "List the files under /repos.",
          name: "casey",
        },
      ]);
      const names = toolNames(child);
      expect(names).toContain("bash");
      for (const cut of ["delegate", "memory_edit", "visualize", "email_user"])
        expect(names).not.toContain(cut);
      child.reply("three files");
      const next = await waitScript(chat.scripted, 3);
      expect(isChild(next)).toBe(false);
      expect(lastResult(next)).toBe("three files");
      next.reply("the repo has three files");
      await settled(chat, sessionId);

      const [childId] = childrenOf(chat, sessionId);
      expect(scratchLeft(chat, childId!)).toBe(0);
      const [row] = delegateRows(chat, sessionId);
      expect(row).toMatchObject({ status: "done", childSessionId: childId });
      const detail = await (
        await chat.member.call("GET", `/api/sessions/${sessionId}`)
      ).json();
      expect(
        detail.messages.find((m: { id: string }) => m.id === row!.id)
          .childSessionId,
      ).toBe(childId);
      expect(
        (await chat.member.call("GET", `/api/sessions/${childId}`)).status,
      ).toBe(404);
      const sends = chat.app.db
        .query<{ status: string; cause: string; kind: string }, [string]>(
          "select status, cause, kind from sends where session_id = ?",
        )
        .all(childId!);
      expect(sends).toEqual([
        { status: "done", cause: "finish", kind: "chat" },
      ]);
      const usage = chat.app.db
        .query<{ n: number }, [string]>(
          `select count(*) as n from usage where session_id = ?`,
        )
        .get(childId!)!;
      expect(usage.n).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("past childrenPerSend a call is refused and the parent goes on", async () => {
    const chat = await subagentApp();
    try {
      await setLimits(chat, { childrenPerSend: 1 });
      const { script, sessionId } = await startChat(chat);
      script.toolRound([
        delegateCall("d1", "first task"),
        delegateCall("d2", "second task"),
      ]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      child.reply("one");
      const next = await waitScript(chat.scripted, 3);
      const results = wire(next).filter((m) => m.role === "tool");
      expect(results.map((m) => m.content)).toEqual([
        "one",
        "Not run: this turn has used its 1 subagents. Do the rest yourself.",
      ]);
      next.reply("done");
      await settled(chat, sessionId);
      expect(childrenOf(chat, sessionId)).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a child at its window answers and never compacts", async () => {
    const chat = await subagentApp();
    try {
      chat.app.db
        .query("update agents set context_length = 20000 where id = ?")
        .run(chat.agentId);
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "big task")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      child.content("a long read, answered");
      child.finish();
      child.usage({ prompt: 19_500, completion: 100 });
      child.end();
      const next = await waitScript(chat.scripted, 3);
      expect(isChild(next)).toBe(false);
      expect(lastResult(next)).toBe("a long read, answered");
      next.reply("done");
      await settled(chat, sessionId);
      const [childId] = childrenOf(chat, sessionId);
      expect(
        chat.app.sessions.messages(childId!).map((row) => row.kind),
      ).toEqual(["user", "reply"]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a child's time is not the parent's toolMs", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "slow task")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      chat.app.now.value += 30_000;
      child.reply("slow answer");
      await waitScript(chat.scripted, 3);
      const parent = chat.app.runner.registry.get(sessionId)!;
      expect(parent.budget.toolMs).toBe(0);
      expect(parent.budget.calls).toBe(1);
      chat.scripted.scripts[2]!.reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a child that fails gives a failed result with its last words", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "break")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.content("half way");
      child.end();
      const next = await waitScript(chat.scripted, 3);
      expect(lastResult(next)).toContain("The subagent failed:");
      expect(lastResult(next)).toContain("Its last words:\nhalf way");
      next.reply("I will do it myself");
      await settled(chat, sessionId);
      expect(delegateRows(chat, sessionId)[0]!.status).toBe("failed");
      expect(scratchLeft(chat, childrenOf(chat, sessionId)[0]!)).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a child whose setup fails ends failed and leaves no scratch", async () => {
    const chat = await subagentApp();
    try {
      const copy = chat.app.bash.copyScratch;
      chat.app.bash.copyScratch = (from, to) => {
        copy(from, to);
        throw new Error("the disk is gone");
      };
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "set up")]);
      script.end();
      const next = await waitScript(chat.scripted, 2);
      expect(isChild(next)).toBe(false);
      expect(lastResult(next)).toBe("The subagent failed: the disk is gone.");
      next.reply("I will do it myself");
      await settled(chat, sessionId);
      const [childId] = childrenOf(chat, sessionId);
      expect(chat.app.sessions.byId(childId!)!.status).toBe("failed");
      expect(chat.app.sessions.lastSend(childId!)).toMatchObject({
        status: "failed",
        cause: "failure",
      });
      expect(
        chat.app.sessions
          .messages(childId!)
          .filter((row) => row.status === "streaming"),
      ).toEqual([]);
      expect(scratchLeft(chat, childId!)).toBe(0);
      expect(delegateRows(chat, sessionId)[0]!.status).toBe("failed");
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the parent's end ends its children", () => {
  test("Stop ends a running child and the parent waits for it", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "long task")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/stop`,
      );
      expect(stop.status).toBeLessThan(300);
      const ended = await settled(chat, sessionId);
      expect(ended.status).toBe("stopped");
      expect(child.aborted).toBe(true);
      const [childId] = childrenOf(chat, sessionId);
      expect(chat.app.sessions.lastSend(childId!)).toMatchObject({
        status: "stopped",
        cause: "stop",
      });
      expect(scratchLeft(chat, childId!)).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the parent's deadline is the child's, never a fresh one", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      chat.app.now.value += DEFAULT_LIMITS.sendDeadlineMs - 10_000;
      script.toolRound([delegateCall("d1", "long task")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      const [childId] = childrenOf(chat, sessionId);
      expect(
        chat.app.db
          .query<{ n: number }, [string]>(
            "select count(*) as n from sends where session_id = ?",
          )
          .get(childId!)!.n,
      ).toBe(1);
      chat.app.now.value += 10_000;
      const ended = await settled(chat, sessionId);
      expect(ended.status).toBe("stopped");
      expect(child.aborted).toBe(true);
      expect(chat.app.sessions.lastSend(childId!)).toMatchObject({
        cause: "deadline",
      });
      expect(scratchLeft(chat, childId!)).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a run's child", () => {
  test("gets no memory phase or attention step; the parent gets each once", async () => {
    const chat = await subagentApp();
    try {
      const automation = await createAutomation(chat, {
        ownMemory: true,
        attentionMode: "agent",
      });
      const run = await startRun(chat, automation.id);
      run.main.toolRound([delegateCall("d1", "check the disks")]);
      run.main.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      expect(system(child)).not.toContain("automation");
      child.reply("disks are fine");
      const answer = await waitScript(chat.scripted, 3);
      expect(lastResult(answer)).toBe("disks are fine");
      answer.reply("all good");
      // the attention step and the memory phase, each the parent's alone
      let answered = 3;
      for (let i = 0; i < 400; i++) {
        if (chat.app.runner.registry.get(run.sessionId) === null) break;
        const scripts = chat.scripted.scripts;
        if (scripts.length > answered) {
          expect(isChild(scripts[answered]!)).toBe(false);
          scripts[answered]!.reply("nothing");
          answered++;
        }
        await tick();
      }
      await settled(chat, run.sessionId);
      const steps = chat.scripted.scripts.slice(3).map((s) => toolNames(s));
      expect(steps.some((names) => names.includes("needs_attention"))).toBe(
        true,
      );
      expect(steps.some((names) => names.includes("memory_edit"))).toBe(true);
      const [childId] = childrenOf(chat, run.sessionId);
      expect(
        chat.app.db
          .query(
            "select kind, memory_round, attention_round from sends where session_id = ?",
          )
          .get(childId!),
      ).toEqual({ kind: "run", memory_round: null, attention_round: null });
      expect(
        chat.scripted.scripts.filter((s) => system(s).includes(SUBAGENT_LINE)),
      ).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("restart repair", () => {
  test.serial(
    "ends a running child, drops its scratch and fails its delegate row",
    async () => {
      const chat = await subagentApp();
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "long task")]);
      script.end();
      await waitScript(chat.scripted, 2);
      for (let i = 0; i < 50 && childrenOf(chat, sessionId).length === 0; i++)
        await tick();
      const [childId] = childrenOf(chat, sessionId);
      expect(scratchLeft(chat, childId!)).toBeGreaterThan(0);
      chat.app.automationScheduler.dispose();
      const restarted = await testApp({
        db: chat.app.db,
        fetcher: chat.scripted.fetcher,
      });
      try {
        expect(restarted.sessions.byId(childId!)!.status).toBe("failed");
        expect(scratchLeft(chat, childId!)).toBe(0);
        expect(restarted.sessions.byId(sessionId)!.status).toBe("failed");
        const [row] = delegateRows(chat, sessionId);
        expect(row!.status).toBe("failed");
        expect(row!.childSessionId).toBe(childId);
        expect(
          chat.app.db
            .query("select status, cause from sends where session_id = ?")
            .get(childId!),
        ).toEqual({ status: "failed", cause: "restart" });
      } finally {
        await restarted.shutdown();
      }
    },
  );
});
