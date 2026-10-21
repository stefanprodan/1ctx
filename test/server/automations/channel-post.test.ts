// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's answer posted to its project's channel: the switch, the one
// post a done run writes, nothing from any other end, how a summoned
// agent reads it, the page and the post outliving its run.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { tokens } from "../../../src/server/lib/tokens.ts";
import { TRACE_HEADING } from "../../../src/server/runner/trace.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import { automationBody, settleRun } from "../../helpers/automations.ts";
import { channelApp, localAt, messagesOf } from "../../helpers/channel.ts";
import { type ChatApp, idle, waitScript } from "../../helpers/chat.ts";

type Channel = Awaited<ReturnType<typeof channelApp>>;

async function teamAutomation(
  setup: Channel,
  fields: { postToChannel?: boolean; name?: string; deadlineMs?: number } = {},
): Promise<AutomationSummary> {
  const response = await setup.chat.member.call(
    "POST",
    `/api/projects/${setup.project.id}/automations`,
    {
      body: {
        ...automationBody(setup.chat, {
          name: fields.name,
          deadlineMs: fields.deadlineMs,
        }),
        ...(fields.postToChannel === undefined
          ? {}
          : { postToChannel: fields.postToChannel }),
      },
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()).automation;
}

// a manual run in the team project and the script of its first round
async function run(chat: ChatApp, automationId: string) {
  const before = chat.scripted.scripts.length;
  const response = await chat.member.call(
    "POST",
    `/api/automations/${automationId}/run`,
  );
  expect(response.status).toBe(201);
  const detail = await response.json();
  return {
    sessionId: detail.session.id as string,
    main: await waitScript(chat.scripted, before + 1),
  };
}

// a run that calls bash once, then answers
async function doneRun(setup: Channel, automationId: string, answer: string) {
  const { chat } = setup;
  const started = await run(chat, automationId);
  const next = await setup.tool(started.main, "printf 'secret-%s' 'output'");
  next.reply(answer);
  expect((await settleRun(chat, started.sessionId))?.status).toBe("done");
  return started.sessionId;
}

const runPosts = (setup: Channel): Message[] =>
  setup.chat.app.sessions
    .messages(setup.channelId)
    .filter((row) => row.run !== undefined);

describe("the Post to channel switch", () => {
  test("is off by default, saved in a team project, refused in a personal one", async () => {
    const setup = await channelApp();
    const { chat } = setup;
    try {
      const plain = await teamAutomation(setup);
      expect(plain.postToChannel).toBe(false);
      const patched = await chat.member.call(
        "PATCH",
        `/api/automations/${plain.id}`,
        { body: { postToChannel: true, editRevision: plain.editRevision } },
      );
      expect(patched.status).toBe(200);
      expect((await patched.json()).automation.postToChannel).toBe(true);
      expect(chat.app.automations.byId(plain.id)?.postToChannel).toBe(true);

      const personal = await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/automations`,
        { body: { ...automationBody(chat), postToChannel: true } },
      );
      expect(personal.status).toBe(400);
      expect(await personal.text()).toContain(
        "a personal project has no channel",
      );
      const own = await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/automations`,
        { body: automationBody(chat, { name: "mine" }) },
      );
      const mine: AutomationSummary = (await own.json()).automation;
      expect(mine.postToChannel).toBe(false);
      const refused = await chat.member.call(
        "PATCH",
        `/api/automations/${mine.id}`,
        { body: { postToChannel: true, editRevision: mine.editRevision } },
      );
      expect(refused.status).toBe(400);
      expect(chat.app.automations.byId(mine.id)?.postToChannel).toBe(false);
      const typed = await chat.member.call(
        "PATCH",
        `/api/automations/${plain.id}`,
        { body: { postToChannel: "yes", editRevision: 1 } },
      );
      expect(typed.status).toBe(400);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a run's post", () => {
  test.serial(
    "a done run posts its answer once, with its calls and run, and starts no turn",
    async () => {
      const setup = await channelApp();
      const { chat, channelId } = setup;
      const events: BusEvent[] = [];
      const stop = subscribe((event) => events.push(event), silent);
      try {
        const automation = await teamAutomation(setup, {
          postToChannel: true,
          name: "nightly-check",
        });
        const before = chat.app.sessions.byId(channelId)!;
        const scripts = chat.scripted.scripts.length;
        chat.app.now.value += 60_000;
        const runId = await doneRun(
          setup,
          automation.id,
          "All pods are green.",
        );
        await idle(chat.app);

        const posts = runPosts(setup);
        expect(posts).toHaveLength(1);
        const post = posts[0]!;
        expect(post).toMatchObject({
          kind: "reply",
          slot: "answer",
          status: "done",
          round: 1,
          userId: null,
          agentId: chat.agentId,
          content: "All pods are green.",
          toolCalls: null,
        });
        expect(post.html).toContain("All pods are green.");
        expect(post.run).toEqual({
          sessionId: runId,
          automationName: "nightly-check",
          calls: [
            {
              name: "bash",
              arguments: JSON.stringify({
                command: "printf 'secret-%s' 'output'",
              }),
              status: "done",
              saved: null,
            },
          ],
        });
        // the calls only, never their results
        expect(JSON.stringify(post)).not.toContain("secret-output");
        const send = chat.app.sessions.send(post.sendId)!;
        expect(send).toMatchObject({
          kind: "post",
          agentId: chat.agentId,
          userId: chat.memberId,
          status: "done",
          firstMessageId: post.id,
        });
        const after = chat.app.sessions.byId(channelId)!;
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(after.lastActivityAt).toBe(post.createdAt);
        expect(after.status).toBe("done");

        // the channel's event, as a post's, carries the row and its send
        const frame = events.find(
          (event) =>
            event.type === "session.changed" &&
            event.data.session.id === channelId,
        );
        expect(frame).toMatchObject({
          data: {
            messages: [{ id: post.id, run: { sessionId: runId } }],
            send: { id: send.id, kind: "post" },
            last: { author: "coder", text: "All pods are green." },
          },
        });

        // no turn: no send runs or waits in the channel, no request made
        expect(chat.app.runner.registry.inSession(channelId)).toEqual([]);
        expect(chat.app.sessions.pending.ofSession(channelId)).toEqual([]);
        // the run's two rounds and nothing more
        expect(chat.scripted.scripts.length).toBe(scripts + 2);

        // the run itself is unchanged: its rows and its results stay its own
        const own = chat.app.sessions.messages(runId);
        expect(own.find((row) => row.kind === "tool")?.content).toContain(
          "secret-output",
        );
        expect(own.some((row) => row.run !== undefined)).toBe(false);

        // the page reads it on its own anchor, after an earlier post
        const detail = await setup.detail();
        expect(detail.messages.map((row) => row.id)).toContain(post.id);
        expect(detail.messages.find((row) => row.id === post.id)?.run).toEqual(
          post.run,
        );
        // the meter counts it as every reader reads it: answer and trace
        expect(detail.channelContext?.tokens).toBe(
          tokens(
            JSON.stringify([
              { role: "user", content: "[coder] All pods are green." },
              {
                role: "user",
                content: `${TRACE_HEADING}\nbash printf 'secret-%s' 'output' ok`,
              },
            ]),
          ),
        );
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );

  test("with the switch off a done run posts nothing", async () => {
    const setup = await channelApp();
    const { chat, channelId } = setup;
    try {
      const automation = await teamAutomation(setup);
      const revision = chat.app.sessions.byId(channelId)!.revision;
      await doneRun(setup, automation.id, "All pods are green.");
      expect(chat.app.sessions.messages(channelId)).toEqual([]);
      expect(chat.app.sessions.byId(channelId)!.revision).toBe(revision);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a failed, a stopped and a deadline run post nothing", async () => {
    const setup = await channelApp();
    const { chat, channelId } = setup;
    try {
      const automation = await teamAutomation(setup, {
        postToChannel: true,
        deadlineMs: 60_000,
      });
      const failed = await run(chat, automation.id);
      failed.main.content("half an answer");
      failed.main.end();
      expect((await settleRun(chat, failed.sessionId))?.status).toBe("failed");

      chat.app.now.value += 60_000;
      const stopped = await run(chat, automation.id);
      stopped.main.content("part of an answer");
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${stopped.sessionId}/stop`,
      );
      expect(stop.status).toBe(200);
      expect((await settleRun(chat, stopped.sessionId))?.status).toBe(
        "stopped",
      );

      chat.app.now.value += 60_000;
      const late = await run(chat, automation.id);
      late.main.content("still working");
      chat.app.now.value += 60_000;
      expect((await settleRun(chat, late.sessionId))?.status).toBe("stopped");
      expect(chat.app.sessions.lastSend(late.sessionId)?.cause).toBe(
        "deadline",
      );
      expect(chat.app.sessions.messages(channelId)).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a summoned agent reads it as another agent's answer with its trace, its own agent too", async () => {
    const setup = await channelApp();
    const { chat, summon } = setup;
    try {
      const automation = await teamAutomation(setup, { postToChannel: true });
      await doneRun(setup, automation.id, "All pods are green.");
      for (const name of ["coder", "reviewer"]) {
        const turn = await summon(name, "what did the check find?");
        const stream = messagesOf(turn.script).slice(1, localAt(turn.script));
        const at = stream.findIndex(
          (m) => m.content === "[coder] All pods are green.",
        );
        expect(at).toBeGreaterThanOrEqual(0);
        expect(stream[at]).toMatchObject({ role: "user" });
        expect(stream[at]!.name).toBeUndefined();
        expect(stream[at + 1]).toMatchObject({
          role: "user",
          content: `${TRACE_HEADING}\nbash printf 'secret-%s' 'output' ok`,
        });
        // never as an assistant turn and never with its results
        expect(
          stream.some(
            (m) => m.role === "assistant" && m.content.includes("All pods are"),
          ),
        ).toBe(false);
        expect(JSON.stringify(turn.script.body)).not.toContain("secret-output");
        turn.script.reply(`${name} read it`);
        await turn.send.drained;
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the page anchors it among member posts and pages past it", async () => {
    const setup = await channelApp();
    const { chat, channelId, post } = setup;
    try {
      const automation = await teamAutomation(setup, { postToChannel: true });
      expect((await post("before the run")).status).toBe(201);
      await doneRun(setup, automation.id, "All pods are green.");
      expect((await post("after the run")).status).toBe(201);
      const detail = await setup.detail();
      expect(detail.messages.map((row) => row.content)).toEqual([
        "before the run",
        "All pods are green.",
        "after the run",
      ]);
      expect(detail.page).toEqual({ before: null, after: null });
      // a page that starts below it reaches it by its cursor
      const page = chat.app.sessions.channelPage(channelId, {
        before: detail.messages[2]!.seq,
        around: null,
      });
      expect(page.messages.map((row) => row.content)).toEqual([
        "before the run",
        "All pods are green.",
      ]);
      const window = chat.app.sessions.channelPage(channelId, {
        before: null,
        around: detail.messages[1]!.seq,
      });
      expect(window.messages.map((row) => row.content)).toContain(
        "All pods are green.",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "deleting the run clears the link, keeps the text and moves the channel",
    async () => {
      const setup = await channelApp();
      const { chat, channelId } = setup;
      const events: BusEvent[] = [];
      const stop = subscribe((event) => events.push(event), silent);
      try {
        const automation = await teamAutomation(setup, { postToChannel: true });
        const runId = await doneRun(
          setup,
          automation.id,
          "All pods are green.",
        );
        await idle(chat.app);
        const revision = chat.app.sessions.byId(channelId)!.revision;
        events.length = 0;
        const removed = await chat.member.call(
          "DELETE",
          `/api/sessions/${runId}`,
        );
        expect(removed.status).toBe(200);
        const [post] = runPosts(setup);
        expect(post).toMatchObject({
          content: "All pods are green.",
          run: { sessionId: null, automationName: null },
        });
        expect(post!.run!.calls).toHaveLength(1);
        expect(chat.app.sessions.byId(channelId)!.revision).toBe(revision + 1);
        expect(
          events.find(
            (event) =>
              event.type === "session.changed" &&
              event.data.session.id === channelId,
          ),
        ).toMatchObject({
          data: { messages: [{ id: post!.id, run: { sessionId: null } }] },
        });

        // a second run gone with its automation clears its link the same way
        const second = await doneRun(setup, automation.id, "Still green.");
        const deleted = await chat.member.call(
          "DELETE",
          `/api/automations/${automation.id}?runs=delete`,
        );
        expect(deleted.status).toBe(204);
        expect(chat.app.sessions.byId(second)).toBeNull();
        expect(
          runPosts(setup).map((row) => [row.content, row.run?.sessionId]),
        ).toEqual([
          ["All pods are green.", null],
          ["Still green.", null],
        ]);
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );
});
