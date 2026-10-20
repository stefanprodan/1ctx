// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { CHANNEL_LINE } from "../../../src/server/runner/channel-prompt.ts";
import { channelRead } from "../../../src/server/runner/channel-read.ts";
import { SKILLS_LEAD } from "../../../src/server/runner/context.ts";
import { TRACE_HEADING } from "../../../src/server/runner/trace.ts";
import { sweepChats } from "../../../src/server/sessions/sweep.ts";
import { channelApp, localAt, messagesOf } from "../../helpers/channel.ts";
import {
  ANTHROPIC_MODEL,
  idle,
  setLimits,
  varied,
} from "../../helpers/chat.ts";

describe("channel context", () => {
  test("a fixed start snapshot keeps a running agent's post, not its work or later answer", async () => {
    const { chat, channelId, post, summon, tool } = await channelApp();
    try {
      await post("before either turn");
      const a = await summon("coder", "first question");
      const aNext = await tool(a.script);
      const b = await summon("reviewer", "second question", chat.admin);
      const before = JSON.stringify(
        messagesOf(b.script).slice(0, localAt(b.script)),
      );
      expect(before).toContain("before either turn");
      expect(before).toContain("@coder first question");
      expect(before).not.toContain("tool-payload");
      expect(before).not.toContain(TRACE_HEADING);
      expect(before).not.toContain("@reviewer second question");
      aNext.reply("answer finished after reviewer started");
      await a.send.drained;
      await post("posted after reviewer started");
      const bNext = await tool(b.script);
      expect(JSON.stringify(messagesOf(bNext).slice(0, localAt(bNext)))).toBe(
        before,
      );
      expect(JSON.stringify(bNext.body)).not.toContain("answer finished after");
      expect(JSON.stringify(bNext.body)).not.toContain("posted after reviewer");
      expect(messagesOf(bNext).at(-1)).toMatchObject({
        role: "tool",
        content: expect.stringContaining("tool-payload"),
      });
      bNext.reply("review complete");
      await idle(chat.app);
      expect(
        chat.app.sessions
          .messages(channelId)
          .some(
            (row) => row.content === "answer finished after reviewer started",
          ),
      ).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("interleaved finished turns render once by their posts; foreign answers have only traces", async () => {
    const { chat, channelId, summon, tool } = await channelApp();
    try {
      const a = await summon("coder", "first");
      const b = await summon("reviewer", "second");
      const aNext = await tool(a.script, "printf 'a-%s' 'result'");
      const bNext = await tool(b.script, "printf 'b-%s' 'result'");
      bNext.reply("second answer");
      await b.send.drained;
      aNext.reply("first answer");
      await idle(chat.app);
      const next = await summon("coder", "third");
      const messages = messagesOf(next.script);
      const answer = messages.findIndex(
        (m) => m.content === "[reviewer] second answer",
      );
      expect(answer).toBeGreaterThan(0);
      expect(messages[answer + 1]).toMatchObject({
        role: "user",
        content: expect.stringContaining(TRACE_HEADING),
      });
      expect(JSON.stringify(messages)).not.toContain("b-result");
      expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
      expect(
        messages.findIndex((m) => m.content === "first answer"),
      ).toBeLessThan(answer);
      expect(
        messages.filter((m) => m.content === "[reviewer] second answer"),
      ).toHaveLength(1);
      const raw = channelRead(chat.app.db, channelId, 0);
      expect(raw.rows.every((row) => row.html === "")).toBe(true);
      expect(
        raw.rows
          .filter((row) => row.kind === "tool")
          .every((row) => row.content === ""),
      ).toBe(true);
      next.script.reply("third answer");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each(["whole", "over", "swept"] as const)(
    "the own last turn replays as %s",
    async (mode) => {
      const { chat, channelId, summon } = await channelApp();
      try {
        const skill = chat.app.skills.create(
          {
            name: "ops",
            description: "Operations",
            body: "SKILL_BODY_ONLY",
            license: "",
            compatibility: "",
            metadata: {},
            allowedTools: "",
            sourceKind: "file",
            sourceUrl: "https://skills.test/ops.md",
            sourceSelect: "",
            sourceDigest: "",
            digest: "ops-digest",
            dropped: [],
            droppedMore: 0,
            files: [],
          },
          chat.app.now.value,
        );
        chat.app.skills.assign(chat.agentId, [skill.id]);
        const a = await summon();
        a.script.toolRound([
          { id: "skill", name: "skill", arguments: '{"name":"ops"}' },
          {
            id: "bash",
            name: "bash",
            arguments: JSON.stringify({ command: "printf 'tool-payload'" }),
          },
        ]);
        a.script.end();
        const next = await chat.scripted.reached(2);
        expect(JSON.stringify(next.body)).toContain("SKILL_BODY_ONLY");
        next.reply("the prior answer");
        await idle(chat.app);
        if (mode === "over") {
          chat.app.db
            .query(
              "update messages set content = ? where send_id = ? and kind = 'tool' and tool_name = 'bash'",
            )
            .run(varied(220_000, "RESULT_ONLY_"), a.send.id);
        }
        if (mode === "swept") {
          chat.app.db
            .query("update sends set swept = 1 where id = ?")
            .run(a.send.id);
        }
        const b = await summon();
        const messages = messagesOf(b.script).slice(0, localAt(b.script));
        expect(messages.filter((m) => m.role === "tool")).toHaveLength(
          mode === "whole" ? 2 : 0,
        );
        expect(JSON.stringify(messages).includes("SKILL_BODY_ONLY")).toBe(
          mode === "whole",
        );
        expect(messages.some((m) => m.tool_calls?.length)).toBe(
          mode === "whole",
        );
        expect(JSON.stringify(messages)).not.toContain("RESULT_ONLY_");
        if (mode !== "whole") {
          const trace = messages.findIndex((m) =>
            m.content.startsWith(TRACE_HEADING),
          );
          expect(trace).toBeGreaterThan(0);
          expect(messages[trace + 1]).toMatchObject({
            role: "assistant",
            content: "the prior answer",
          });
        }
        expect(JSON.stringify(messages)).not.toContain(SKILLS_LEAD);
        b.script.reply("done");
        await idle(chat.app);
        expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("the aging sweep makes the own last turn trace-only", async () => {
    const { chat, channelId, summon, tool } = await channelApp();
    try {
      const a = await summon();
      (await tool(a.script)).reply("the aged answer");
      await idle(chat.app);
      expect(
        chat.app.db
          .query<{ swept: number | null }, [string]>(
            "select swept from sends where id = ?",
          )
          .get(a.send.id)?.swept,
      ).toBe(0);
      const swept = sweepChats(
        {
          db: chat.app.db,
          store: chat.app.sessions,
          scratch: chat.app.bash.scratch,
          log: silent,
        },
        chat.app.now.value + (DEFAULT_LIMITS.archiveIdleDays + 1) * DAY_MS,
        DEFAULT_LIMITS,
      );
      expect(swept.turns_swept).toBe(1);
      expect(chat.app.sessions.send(a.send.id)?.swept).toBe(true);
      expect(
        channelRead(chat.app.db, channelId, 0).turns.get(a.send.id)?.swept,
      ).toBe(true);
      expect(
        chat.app.sessions
          .messages(channelId)
          .filter((row) => row.sendId === a.send.id && row.kind === "tool")
          .map((row) => row.content),
      ).toEqual([""]);

      const b = await summon();
      const messages = messagesOf(b.script).slice(0, localAt(b.script));
      const trace = messages.findIndex((m) =>
        m.content.startsWith(TRACE_HEADING),
      );
      expect(trace).toBeGreaterThan(0);
      expect(messages[trace]?.content).toContain(
        "bash printf 'tool-%s' 'payload' ok",
      );
      expect(messages[trace + 1]).toMatchObject({
        role: "assistant",
        content: "the aged answer",
      });
      expect(messages.some((m) => m.tool_calls?.length)).toBe(false);
      expect(messages.filter((m) => m.role === "tool")).toHaveLength(0);
      expect(JSON.stringify(messages)).not.toContain("tool-payload");
      b.script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("older own turns are traces even when both fit the whole-turn cap", async () => {
    const { chat, summon, tool } = await channelApp();
    try {
      for (const answer of ["older answer", "last answer"]) {
        const a = await summon();
        (await tool(a.script)).reply(answer);
        await idle(chat.app);
      }
      const third = await summon();
      const messages = messagesOf(third.script);
      const traced = messages.findIndex((m) =>
        m.content.startsWith(TRACE_HEADING),
      );
      expect(messages[traced + 1]).toMatchObject({
        role: "assistant",
        content: "older answer",
      });
      expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
      third.script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("memory, author, day and notes follow the cached stream, fixed over rounds and summoners", async () => {
    const { chat, project, post, summon, tool } = await channelApp();
    try {
      const scope = { projectId: project.id, automationId: null };
      chat.app.memory.save(
        scope,
        [{ topic: "Units", text: "metric" }],
        0,
        chat.memberId,
        chat.app.now.value,
      );
      await post("a shared post");
      const a = await summon();
      const at = localAt(a.script);
      expect(at).toBe(2);
      const prefix = JSON.stringify(messagesOf(a.script).slice(0, at));
      expect(messagesOf(a.script)[0]?.content).toContain(CHANNEL_LINE);
      expect(messagesOf(a.script)[0]?.content).not.toContain("You talk to");
      expect(messagesOf(a.script)[0]?.content).not.toContain("project-memory");
      expect(messagesOf(a.script)[1]).toMatchObject({ name: "casey" });
      expect(messagesOf(a.script)[at]?.content).toContain("metric");
      expect(messagesOf(a.script)[at + 1]?.content).toBe("@coder check this");
      chat.app.memory.save(
        scope,
        [{ topic: "Units", text: "imperial" }],
        1,
        chat.memberId,
        chat.app.now.value,
      );
      a.send.mcpNote = "MCP note fixed at first request";
      const next = await tool(a.script);
      expect(JSON.stringify(messagesOf(next).slice(0, at + 1))).toBe(
        JSON.stringify(messagesOf(a.script).slice(0, at + 1)),
      );
      next.reply("first answer");
      await idle(chat.app);
      chat.app.now.value += 86_400_000;
      const b = await summon("coder", "ask again", chat.admin);
      expect(JSON.stringify(messagesOf(b.script).slice(0, at))).toBe(prefix);
      expect(messagesOf(b.script)[localAt(b.script)]?.content).toContain(
        "@admin",
      );
      expect(messagesOf(b.script)[localAt(b.script)]?.content).toContain(
        "imperial",
      );
      expect(b.script.body.prompt_cache_key).toBe(
        a.script.body.prompt_cache_key,
      );
      expect(b.script.body.prompt_cache_key).toBe(
        `${b.send.sessionId}:${chat.agentId}`,
      );
      b.script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("anthropic keeps live thinking but drops it from the replayed whole tail", async () => {
    const { chat, summon, tool } = await channelApp({
      wire: "anthropic",
      model: ANTHROPIC_MODEL,
    });
    try {
      const a = await summon();
      a.script.reasoning("private-thought");
      a.script.sse(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"past-signature"}}\n\n',
      );
      const next = await tool(a.script);
      expect(JSON.stringify(next.body.messages)).toContain("private-thought");
      expect(JSON.stringify(next.body.messages)).toContain("past-signature");
      expect(JSON.stringify(next.body.messages)).toContain('"type":"thinking"');
      next.reply("first answer");
      await idle(chat.app);
      expect(
        chat.app.db
          .query<{ n: number }, [string]>(
            "select count(*) as n from messages where send_id = ? and reasoning != ''",
          )
          .get(a.send.id)!.n,
      ).toBe(1);
      chat.app.db
        .query(
          "update messages set reasoning = ? where send_id = ? and reasoning != ''",
        )
        .run("private-thought ".repeat(20_000), a.send.id);
      const b = await summon();
      expect(JSON.stringify(b.script.body.messages)).not.toContain(
        "private-thought",
      );
      expect(JSON.stringify(b.script.body.messages)).not.toContain(
        '"type":"thinking"',
      );
      expect(JSON.stringify(b.script.body.messages)).not.toContain(
        "past-signature",
      );
      expect(JSON.stringify(b.script.body.messages)).toContain("tool_result");
      b.script.reasoning("current-thought");
      b.script.sse(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"current-signature"}}\n\n',
      );
      const bNext = await tool(b.script);
      expect(JSON.stringify(bNext.body.messages)).toContain("current-thought");
      expect(JSON.stringify(bNext.body.messages)).toContain(
        "current-signature",
      );
      expect(JSON.stringify(bNext.body.messages)).not.toContain(
        "private-thought",
      );
      expect(JSON.stringify(bNext.body.messages)).not.toContain(
        "past-signature",
      );
      expect(JSON.stringify(bNext.body.messages)).toContain(
        '"type":"thinking"',
      );
      bNext.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a channel reads its stream once and never compacts, even past the threshold", async () => {
    const { chat, summon, tool } = await channelApp();
    try {
      const query = spyOn(chat.app.db, "query");
      const all = spyOn(chat.app.sessions, "messages");
      try {
        const a = await summon();
        const initial = query.mock.calls.filter(([sql]) =>
          sql.includes("as firstSeq"),
        ).length;
        expect(initial).toBe(1);
        const next = await tool(a.script);
        expect(
          query.mock.calls.filter(([sql]) => sql.includes("as firstSeq")),
        ).toHaveLength(initial);
        expect(all).not.toHaveBeenCalled();
        next.content("answer");
        next.finish();
        next.usage({ prompt: a.send.policy.contextLength!, completion: 5 });
        next.end();
        await idle(chat.app);
        expect(chat.scripted.scripts).toHaveLength(2);
      } finally {
        query.mockRestore();
        all.mockRestore();
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("opencode replays the own whole turn's reasoning but not traced thinking", async () => {
    const { chat, summon, tool } = await channelApp({ wire: "opencode" });
    try {
      const a = await summon();
      a.script.reasoning("own private reasoning");
      const next = await tool(a.script);
      expect(JSON.stringify(next.body)).toContain("own private reasoning");
      next.reply("first answer");
      await idle(chat.app);
      const b = await summon();
      expect(
        messagesOf(b.script).find((m) => m.reasoning_content),
      ).toMatchObject({ reasoning_content: "own private reasoning" });
      b.script.reply("second answer");
      await idle(chat.app);
      const c = await summon();
      expect(JSON.stringify(c.script.body)).not.toContain(
        "own private reasoning",
      );
      c.script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the exhaustion line stays after the own results, never in the local context slot", async () => {
    const { chat, summon } = await channelApp();
    try {
      await setLimits(chat, { callsPerRound: 1 });
      const a = await summon();
      a.script.toolRound([
        { id: "a", name: "datetime", arguments: "{}" },
        { id: "b", name: "datetime", arguments: "{}" },
      ]);
      a.script.end();
      const next = await chat.scripted.reached(2);
      expect(messagesOf(next).at(-1)?.content).toStartWith("The tool budget");
      expect(localAt(next)).toBe(localAt(a.script));
      expect(messagesOf(next)[localAt(next)]).toEqual(
        messagesOf(a.script)[localAt(a.script)],
      );
      next.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });
});
