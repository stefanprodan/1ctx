// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin's clear of a channel: every message and turn goes with what
// hangs off them, nothing of another session does, the runs and usage
// stay, and a running turn, a member or a chat is refused.

import { describe, expect, test } from "bun:test";
import { proposeTask } from "../../../src/server/automations/propose.ts";
import { writeKeptFiles } from "../../../src/server/bash/index.ts";
import { AUTOMATION_DEFAULTS } from "../../../src/shared/automation-defaults.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { automationBody, settleRun } from "../../helpers/automations.ts";
import { channelApp } from "../../helpers/channel.ts";
import { idle, setLimits, startChat, until } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";
import {
  allowSubagents,
  bashCall,
  childrenOf,
  delegateCall,
} from "../../helpers/subagents.ts";
import { stage } from "./uploads-helpers.ts";

type Setup = Awaited<ReturnType<typeof channelApp>>;

const clear = (setup: Setup, client = setup.chat.admin) =>
  client.call("POST", `/api/sessions/${setup.channelId}/clear`);

// the rows of a table that name the session in a column
function count(setup: Setup, table: string, column = "session_id"): number {
  return setup.chat.app.db
    .query<{ n: number }, [string]>(
      `select count(*) as n from ${table} where ${column} = ?`,
    )
    .get(setup.channelId)!.n;
}

// the script the next chat request opens, once the action sent it
async function nextScript(setup: Setup, act: () => void | Promise<void>) {
  const count = setup.chat.scripted.scripts.length + 1;
  await act();
  return setup.chat.scripted.reached(count);
}

// a done run of a team automation that posts its answer to the channel
async function postedRun(setup: Setup): Promise<string> {
  const { chat } = setup;
  const created = await chat.member.call(
    "POST",
    `/api/projects/${setup.project.id}/automations`,
    {
      body: {
        ...automationBody(chat, { name: "nightly-check" }),
        postToChannel: true,
      },
    },
  );
  expect(created.status).toBe(201);
  const automation: AutomationSummary = (await created.json()).automation;
  let runId = "";
  const main = await nextScript(setup, async () => {
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    expect(response.status).toBe(201);
    runId = (await response.json()).session.id;
  });
  const next = await setup.tool(main, "printf run");
  next.reply("All pods are green.");
  expect((await settleRun(chat, runId))?.status).toBe("done");
  await idle(chat.app);
  return runId;
}

describe("an admin's clear of a channel", () => {
  test.serial(
    "deletes every row of the channel and keeps everything else",
    async () => {
      const setup = await channelApp();
      const { chat, channelId, project } = setup;
      const { db } = chat.app;
      try {
        await setLimits(chat, {
          queuedMinutes: 10,
          sendDeadlineMs: 60 * 60_000,
        });
        allowSubagents(chat, chat.agentId);
        const kept = await startChat(chat);
        kept.script.reply("kept answer");
        await idle(chat.app);
        const keptRows = chat.app.sessions.messages(kept.sessionId).length;

        // a post with a file
        const upload = await stage(
          chat,
          "note.txt",
          "attached text",
          chat.member,
          project.id,
        );
        const posted = await chat.member.call(
          "POST",
          `/api/sessions/${channelId}/messages`,
          { body: { message: "zeta before", uploads: [upload.id] } },
        );
        expect(posted.status).toBe(201);

        // a turn that left a pending turn which did not start
        const first = await setup.summon("coder");
        expect((await setup.post("@coder later")).status).toBe(202);
        const waiting = (await setup.detail()).pending![0]!;
        chat.app.now.value += 10 * 60_000;
        await until(
          () =>
            chat.app.sessions.pending.byId(waiting.id)?.reason === "expired",
        );
        first.script.reply("first done");
        await idle(chat.app);

        // a turn with a bash call and a subagent
        const second = await setup.summon("coder", "dig in");
        const delegating = await nextScript(setup, () => {
          second.script.toolRound([
            bashCall("seed", "printf seed > /tmp/seed.txt"),
          ]);
          second.script.end();
        });
        const child = await nextScript(setup, () => {
          delegating.toolRound([delegateCall("child-a", "look around")]);
          delegating.end();
        });
        const parent = await nextScript(setup, () => {
          child.reply("child done");
        });
        parent.reply("second done");
        await idle(chat.app);
        const runId = await postedRun(setup);

        const tool = chat.app.sessions
          .messages(channelId)
          .find((row) => row.kind === "tool" && row.toolName === "bash")!;
        writeKeptFiles(db, tool.id, [
          {
            folder: 1,
            dir: "0001-bash",
            name: "kept.txt",
            text: "kept",
            data: null,
            bytes: 4,
          },
        ]);
        db.query(
          `insert into opened_files
           (message_id, position, path, kind, language, bytes, lines, title, text)
           values (?, 0, '/tmp/seed.txt', 'code', null, 4, 1, null, 'seed')`,
        ).run(tool.id);
        proposeTask(
          {
            db,
            store: chat.app.automations,
            drafts: chat.app.automationDrafts,
            runDeadlineMs: () => 60 * 60_000,
          },
          {
            projectId: project.id,
            sessionId: channelId,
            sendId: second.send.id,
            messageId: tool.id,
            userId: chat.memberId,
            agentId: chat.agentId,
            action: "create",
            automationId: null,
            fields: {
              ...AUTOMATION_DEFAULTS,
              name: "proposed",
              agentId: chat.agentId,
              instructions: "Check it.",
              schedule: "0 9 * * *",
              tz: "UTC",
              disabledCapabilities: [],
            },
            now: chat.app.now.value,
          },
        );
        db.query("update sessions set dropped_seq = 3 where id = ?").run(
          channelId,
        );

        const [childId] = childrenOf(chat, channelId);
        expect(childId).toBeDefined();
        expect(count(setup, "pending_turns")).toBe(1);
        expect(count(setup, "session_upload_files")).toBe(1);
        expect(count(setup, "session_scratch")).toBeGreaterThan(0);
        expect(count(setup, "mcp_kept_files")).toBe(1);
        expect(count(setup, "automation_drafts")).toBe(1);
        expect(
          chat.app.sessions
            .messages(channelId)
            .some((row) => row.run?.sessionId === runId),
        ).toBe(true);
        const usage = count(setup, "usage");
        expect(usage).toBeGreaterThan(0);
        const before = chat.app.sessions.byId(channelId)!;

        const conn = await watcher(chat);
        watch(chat, conn, channelId);
        expect((await clear(setup, chat.member)).status).toBe(403);
        expect(count(setup, "messages")).toBeGreaterThan(0);
        const response = await clear(setup);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});

        for (const table of [
          "messages",
          "sends",
          "pending_turns",
          "session_upload_files",
          "session_scratch",
          "mcp_kept_files",
        ]) {
          expect([table, count(setup, table)]).toEqual([table, 0]);
        }
        expect(count(setup, "sessions", "parent_session_id")).toBe(0);
        expect(chat.app.sessions.byId(childId!)).toBeNull();
        expect(
          db
            .query(
              "select count(*) as n from opened_files where message_id = ?",
            )
            .get(tool.id),
        ).toEqual({ n: 0 });
        expect(chat.app.automationDrafts.bySession(channelId)).toEqual([]);
        expect(
          db
            .query(
              "select count(*) as n from memory_views where session_id = ? and send_id is not null",
            )
            .get(channelId),
        ).toEqual({ n: 0 });
        expect(
          db
            .query(
              "select bytes, files from session_uploads where session_id = ?",
            )
            .get(channelId),
        ).toEqual({ bytes: 0, files: 0 });

        const after = chat.app.sessions.byId(channelId)!;
        expect(after).toMatchObject({
          id: channelId,
          origin: "channel",
          title: before.title,
          projectId: project.id,
          droppedSeq: null,
        });
        expect(after.revision).toBeGreaterThan(before.revision);
        // what stays: usage, the run, another chat
        expect(count(setup, "usage")).toBe(usage);
        expect(chat.app.sessions.byId(runId)).not.toBeNull();
        expect(chat.app.sessions.messages(runId).length).toBeGreaterThan(0);
        expect(chat.app.sessions.messages(kept.sessionId)).toHaveLength(
          keptRows,
        );

        // every watcher starts over at the clear's revision
        const frame = frames(conn, "session").find((ev) => ev.cleared)!;
        expect(frame).toMatchObject({
          cleared: true,
          messages: [],
          send: null,
          session: { id: channelId, revision: after.revision },
          channelContext: { tokens: 0 },
        });
        expect(frames(conn, "queue").at(-1)).toMatchObject({
          sessionId: channelId,
          pending: [],
        });
        const shown = await setup.detail();
        expect(shown.messages).toEqual([]);
        expect(shown.sends).toEqual([]);
        expect(shown.pending).toEqual([]);

        // the next post opens the stream again, and a turn reads nothing
        // of what went
        const again = await setup.post("after the clear");
        expect(again.status).toBe(201);
        expect((await again.json()).messages[0].seq).toBe(1);
        const fresh = await setup.summon("coder", "start afresh");
        const sent = JSON.stringify(fresh.script.body);
        expect(sent).toContain("start afresh");
        for (const gone of ["zeta before", "first done", "second done"]) {
          expect(sent).not.toContain(gone);
        }
        expect(sent).not.toContain("All pods are green.");
        fresh.script.reply("fresh done");
        await idle(chat.app);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("is refused while a turn runs, to a member, and for a chat", async () => {
    const setup = await channelApp();
    const { chat, project } = setup;
    try {
      // a chat the admin sees, in the channel's project
      const kept = await startChat(chat, "hello", chat.admin, project.id);
      kept.script.reply("kept answer");
      await idle(chat.app);
      const turn = await setup.summon("coder");
      const running = await clear(setup);
      expect(running.status).toBe(409);
      expect(await running.json()).toEqual({ error: "a turn is running" });
      expect(count(setup, "messages")).toBeGreaterThan(0);
      turn.script.reply("done");
      await idle(chat.app);

      expect((await clear(setup, chat.member)).status).toBe(403);
      const chatClear = await chat.admin.call(
        "POST",
        `/api/sessions/${kept.sessionId}/clear`,
      );
      expect(chatClear.status).toBe(400);
      expect(await chatClear.json()).toEqual({
        error: "only a channel is cleared",
      });
      expect(chat.app.sessions.messages(kept.sessionId).length).toBe(2);
      const missing = await chat.admin.call(
        "POST",
        "/api/sessions/nothing/clear",
      );
      expect(missing.status).toBe(404);
      expect(count(setup, "messages")).toBeGreaterThan(0);
      expect((await clear(setup)).status).toBe(200);
      expect(count(setup, "messages")).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });
});
