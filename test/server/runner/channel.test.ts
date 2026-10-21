// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import {
  sessionWorkspace,
  writeKeptFiles,
} from "../../../src/server/bash/index.ts";
import { BadRequest, NotFound } from "../../../src/server/lib/errors.ts";
import { MAX_QUEUED_PER_CHAT } from "../../../src/server/sessions/index.ts";
import type { ChannelPostResponse } from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { hashPassword, testApp } from "../../helpers/app.ts";
import {
  chatApp,
  FLASH,
  idle,
  scriptedFetch,
  sessionSettled,
  setLimits,
  startChat,
  until,
} from "../../helpers/chat.ts";
import { SMTP } from "../../helpers/links.ts";
import { createTeam } from "../../helpers/projects.ts";
import { frames, nextFrame, watch, watcher } from "../../helpers/socket.ts";
import {
  allowSubagents,
  bashCall,
  childrenOf,
  delegateCall,
  delegateRows,
  isChild,
  lastResult,
  toolNames,
} from "../../helpers/subagents.ts";

async function setup() {
  const chat = await chatApp();
  const project = await createTeam(chat.admin, "platform", [chat.memberId]);
  const channelId = chat.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where project_id = ? and origin = 'channel' and parent_session_id is null",
    )
    .get(project.id)!.id;
  const other = await chat.makeAgent({ name: "reviewer", model: FLASH });
  const detail = async (): Promise<SessionDetail> => {
    const response = await chat.member.call(
      "GET",
      `/api/sessions/${channelId}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const post = async (message: string, client = chat.member) => {
    const response = await client.call(
      "POST",
      `/api/sessions/${channelId}/messages`,
      { body: { message } },
    );
    const body = (await response.json()) as ChannelPostResponse;
    if (response.status === 201 || response.status === 202) {
      expect(Object.keys(body).sort()).toEqual(["messages", "send", "session"]);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.content).toBe(message);
      expect(body.send).toMatchObject({
        kind: "post",
        status: "done",
        firstMessageId: body.messages[0]?.id,
      });
    }
    return { status: response.status, body };
  };
  const summon = async (name: string, client = chat.member) => {
    const count = chat.scripted.scripts.length + 1;
    const result = await post(`@${name} check this`, client);
    expect(result.status).toBe(201);
    const script = await chat.scripted.reached(count);
    const send = chat.app.runner.registry
      .inSession(channelId)
      .find((send) => send.policy.agentName === name)!;
    expect(send).toBeDefined();
    return { ...result, script, send };
  };
  return { chat, project, channelId, other, detail, post, summon };
}

describe("channel summons", () => {
  test("restart repairs every running turn, drops its memory view, and resumes pending turns", async () => {
    const { chat, channelId, detail, post, summon } = await setup();
    const kept = await startChat(chat);
    kept.script.reply("keep the chat view");
    await idle(chat.app);
    const first = await summon("coder");
    const second = await summon("reviewer");
    await post("@coder after restart");
    const waiting = (await detail()).pending![0]!;
    const posted = chat.app.sessions.message(waiting.messageId)!;
    const db = Database.deserialize(chat.app.db.serialize(), { strict: true });
    db.exec("pragma foreign_keys = on");
    await chat.app.shutdown();
    const scripts = scriptedFetch();
    const exec = spyOn(db, "exec");
    const app = await testApp({ db, fetcher: scripts.fetcher });
    try {
      const deletes = exec.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes("delete from memory_views"));
      expect(deletes).toHaveLength(1);
      const explain = db.prepare<{ detail: string }, []>(
        `explain query plan ${deletes[0]}`,
      );
      try {
        const plan = explain.all().map((row) => row.detail);
        expect(plan.some((line) => /^SCAN (?:TABLE )?sends\b/.test(line))).toBe(
          false,
        );
      } finally {
        explain.finalize();
      }
      const script = await scripts.reached(1);
      expect(app.sessions.send(first.send.id)?.cause).toBe("restart");
      expect(app.sessions.send(second.send.id)?.cause).toBe("restart");
      const resumed = app.runner.registry.inSession(channelId)[0]!;
      expect(resumed.firstMessageId).toBe(posted.id);
      expect(app.sessions.message(posted.id)).toEqual(posted);
      expect(app.sessions.pending.ofSession(channelId)).toEqual([]);
      expect(
        db.query("select send_id from memory_views order by send_id").all(),
      ).toEqual([{ send_id: null }, { send_id: resumed.id }]);
      expect(app.sessions.byId(channelId)?.status).toBe("running");
      script.reply("resumed");
      await idle(app);
      expect(
        db.query("select session_id, send_id from memory_views").all(),
      ).toEqual([{ session_id: kept.sessionId, send_id: null }]);
      expect(app.sessions.byId(channelId)?.status).toBe("done");
    } finally {
      await app.shutdown();
      exec.mockRestore();
      db.close();
    }
  });

  test("a channel child belongs to its summoner and its agent workspace", async () => {
    const { chat, channelId, other, summon } = await setup();
    allowSubagents(chat, chat.agentId);
    const first = await summon("coder");
    const second = await summon("reviewer", chat.admin);
    first.script.toolRound([
      bashCall("seed-coder", "printf coder > /tmp/coder.txt"),
    ]);
    first.script.end();
    const firstAgain = await chat.scripted.reached(3);
    second.script.toolRound([
      bashCall("seed-reviewer", "printf reviewer > /tmp/reviewer.txt"),
    ]);
    second.script.end();
    const secondAgain = await chat.scripted.reached(4);
    firstAgain.toolRound([delegateCall("child-a", "first task")]);
    firstAgain.end();
    const child = await chat.scripted.reached(5);
    expect(isChild(child)).toBe(true);
    child.toolRound([
      bashCall(
        "child-bash",
        "cat /tmp/coder.txt; test ! -e /tmp/reviewer.txt; printf child > /tmp/child.txt",
      ),
    ]);
    child.end();
    const childAgain = await chat.scripted.reached(6);
    expect(isChild(childAgain)).toBe(true);
    expect(lastResult(childAgain)).toContain("coder");
    const [childId] = childrenOf(chat, channelId);
    expect(chat.app.sessions.byId(childId!)).toMatchObject({
      ownerId: chat.memberId,
      agentId: chat.agentId,
      origin: "channel",
    });
    expect(
      chat.app.db
        .query("select swept from sends where session_id = ?")
        .get(childId!),
    ).toEqual({ swept: null });
    const childTool = chat.app.sessions
      .messages(childId!)
      .find((row) => row.kind === "tool" && row.toolName === "bash")!;
    writeKeptFiles(chat.app.db, childTool.id, [
      {
        folder: 1,
        dir: "0001-bash",
        name: "child.txt",
        text: "child kept",
        data: null,
        bytes: 10,
      },
    ]);
    expect(
      chat.app.db
        .query(
          "select session_id, workspace_id from mcp_kept_files where message_id = ?",
        )
        .get(childTool.id),
    ).toEqual({ session_id: childId, workspace_id: null });
    expect(chat.app.bash.startKept(sessionWorkspace(childId!), null).next).toBe(
      2,
    );
    childAgain.reply("child done");
    const parentAgain = await chat.scripted.reached(7);
    expect(isChild(parentAgain)).toBe(false);
    expect(lastResult(parentAgain)).toContain("child done");
    parentAgain.reply("first parent done");
    secondAgain.reply("second parent done");
    await idle(chat.app);
    expect(first.send.children.started).toBe(1);
    expect(second.send.children.started).toBe(0);
    expect(other).toBe(second.send.policy.agentId);
    expect(
      delegateRows(chat, channelId).map((row) => [row.sendId, row.status]),
    ).toEqual([[first.send.id, "done"]]);
  });

  test("channel project tools receive channel origin", async () => {
    const { chat, channelId, project, summon } = await setup();
    const turn = await summon("coder");
    expect(turn.send).toMatchObject({
      origin: "channel",
      workspace: {
        id: `${channelId}:${chat.agentId}`,
        sessionId: channelId,
      },
    });
    expect(
      chat.app.db
        .query("select swept from sends where id = ?")
        .get(turn.send.id),
    ).toEqual({ swept: 0 });
    expect(toolNames(turn.script)).toEqual(
      expect.arrayContaining(["automation", "external_task", "bash"]),
    );
    turn.script.toolRound([
      {
        id: "automation-list",
        name: "automation",
        arguments: '{"action":"list"}',
      },
      {
        id: "external-list",
        name: "external_task",
        arguments: '{"action":"list"}',
      },
      bashCall("bash-origin", "printf channel > /knowledge/channel-origin.md"),
    ]);
    turn.script.end();
    const next = await chat.scripted.reached(2);
    expect(
      chat.app.sessions
        .messages(channelId)
        .filter((row) => row.sendId === turn.send.id && row.kind === "tool")
        .map((row) => [row.toolName, row.status, row.error]),
    ).toEqual([
      ["automation", "done", null],
      ["external_task", "done", null],
      ["bash", "done", null],
    ]);
    expect(
      chat.app.db
        .query(
          `select session_id, origin from knowledge_files
           where project_id = ? and name = 'channel-origin.md'`,
        )
        .get(project.id),
    ).toEqual({ session_id: channelId, origin: "channel" });
    next.reply("done");
    await idle(chat.app);
  });

  test("real channel summons keep separate bash workspaces", async () => {
    const { chat, channelId, summon } = await setup();
    const first = await summon("coder");
    const second = await summon("reviewer");
    expect(first.send.workspace).not.toEqual(second.send.workspace);
    first.script.toolRound([
      bashCall("coder-seed", "printf coder > /tmp/owner"),
    ]);
    first.script.end();
    const firstAgain = await chat.scripted.reached(3);
    second.script.toolRound([
      bashCall("reviewer-seed", "printf reviewer > /tmp/owner"),
    ]);
    second.script.end();
    const secondAgain = await chat.scripted.reached(4);
    firstAgain.toolRound([bashCall("coder-read", "cat /tmp/owner")]);
    firstAgain.end();
    const firstDone = await chat.scripted.reached(5);
    secondAgain.toolRound([bashCall("reviewer-read", "cat /tmp/owner")]);
    secondAgain.end();
    const secondDone = await chat.scripted.reached(6);
    expect(lastResult(firstDone)).toContain("coder");
    expect(lastResult(firstDone)).not.toContain("reviewer");
    expect(lastResult(secondDone)).toContain("reviewer");
    expect(
      chat.app.db
        .query<{ workspace_id: string }, [string]>(
          `select workspace_id from session_scratch
           where session_id = ? order by workspace_id`,
        )
        .all(channelId)
        .map((row) => row.workspace_id),
    ).toEqual([first.send.workspace.id, second.send.workspace.id].sort());
    firstDone.reply("coder done");
    secondDone.reply("reviewer done");
    await idle(chat.app);
  });
  test("the fake clock expires a pending turn without deleting its post", async () => {
    const { chat, channelId, detail, post, summon } = await setup();
    await setLimits(chat, { queuedMinutes: 10, sendDeadlineMs: 60 * 60_000 });
    const first = await summon("coder");
    await post("@coder stale");
    const waiting = (await detail()).pending![0]!;
    chat.app.now.value += 10 * 60_000;
    await until(
      () => chat.app.sessions.pending.byId(waiting.id)?.reason === "expired",
    );
    expect(chat.app.sessions.message(waiting.messageId)?.content).toBe(
      "@coder stale",
    );
    expect(chat.app.sessions.byId(channelId)?.status).toBe("running");
    first.script.reply("done");
    await idle(chat.app);
    expect(chat.scripted.scripts).toHaveLength(1);
  });

  test("chat and channel pending rows share the summoner's queued limit", async () => {
    const { chat, channelId, post, summon } = await setup();
    await setLimits(chat, { queuedPerUser: 1 });
    const first = await summon("coder");
    const privateChat = await startChat(chat);
    expect((await post("@coder later")).status).toBe(202);
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${privateChat.sessionId}/messages`,
          {
            body: { message: "also wait" },
          },
        )
      ).status,
    ).toBe(429);
    const pending = chat.app.sessions.pending.ofSession(channelId)[0]!;
    await chat.member.call(
      "DELETE",
      `/api/sessions/${channelId}/pending/${pending.id}`,
    );
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${privateChat.sessionId}/messages`,
          {
            body: { message: "also wait" },
          },
        )
      ).status,
    ).toBe(202);
    expect((await post("@coder cannot wait")).status).toBe(429);
    first.script.reply("channel done");
    privateChat.script.reply("chat done");
    (await chat.scripted.reached(3)).reply("queued chat done");
    await idle(chat.app);
  });

  test("two agents run and finish independently, and a post never ends their channel", async () => {
    const { chat, project, channelId, detail, post, summon } = await setup();
    const first = await summon("coder");
    const second = await summon("reviewer", chat.admin);
    expect(chat.app.runner.registry.inSession(channelId)).toHaveLength(2);
    expect(chat.app.runner.registry.get(first.send.id)).toBe(first.send);
    expect(chat.app.runner.registry.get(second.send.id)).toBe(second.send);
    expect(first.send.startedBy).toBe(chat.memberId);
    expect(second.send.startedBy).toBe(chat.adminId);
    expect(first.send.projectId).toBe(project.id);
    const shown = await detail();
    expect(second.body.session.revision).toBeLessThan(shown.session.revision);
    expect(shown.live.map((send) => send.sendId)).toEqual([
      first.send.id,
      second.send.id,
    ]);
    // each agent turn on the page names its post and its summoner
    expect(
      shown.sends?.map((send) => [send.id, send.firstMessageId, send.userId]),
    ).toEqual([
      [first.send.id, first.body.messages[0]!.id, chat.memberId],
      [second.send.id, second.body.messages[0]!.id, chat.adminId],
    ]);
    expect((await post("a note while both work")).body.session.status).toBe(
      "running",
    );
    first.script.reply("coder finished");
    await first.send.drained;
    expect(chat.app.sessions.send(first.send.id)?.status).toBe("done");
    expect(chat.app.sessions.byId(channelId)?.status).toBe("running");
    expect(chat.app.runner.registry.inSession(channelId)).toEqual([
      second.send,
    ]);
    second.script.reply("reviewer finished");
    await sessionSettled(chat.app, channelId);
    expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
    expect(chat.app.runner.live(channelId)).toEqual([]);
    const replies = chat.app.sessions
      .messages(channelId)
      .filter((row) => row.kind === "reply");
    expect(
      replies.map((row) => [row.sendId, row.agentId, row.content]),
    ).toEqual([
      [first.send.id, chat.agentId, "coder finished"],
      [second.send.id, second.send.policy.agentId, "reviewer finished"],
    ]);
    expect(
      chat.app.db
        .query<{ user_id: string; send_id: string }, [string]>(
          "select user_id, send_id from usage where session_id = ? order by rowid",
        )
        .all(channelId),
    ).toEqual([
      { user_id: chat.memberId, send_id: first.send.id },
      { user_id: chat.adminId, send_id: second.send.id },
    ]);
  });

  test("the detail names a pending turn's agent before it has rows", async () => {
    const { chat, channelId, other, detail, post } = await setup();
    const posted = await post("a plain post");
    chat.app.sessions.pending.insert({
      sessionId: channelId,
      messageId: posted.body.messages[0]!.id,
      authorId: chat.memberId,
      agentId: other,
      queuedAt: 1,
    });
    expect((await detail()).agents.map((agent) => agent.name)).toEqual([
      "reviewer",
    ]);
  });

  test("a busy agent's next turn waits on its immutable post while an idle agent starts", async () => {
    const { chat, channelId, detail, post, summon } = await setup();
    const first = await summon("coder");
    const waiting = await post("@coder answer next");
    expect(waiting.status).toBe(202);
    const pending = (await detail()).pending![0]!;
    const posted = chat.app.sessions.message(pending.messageId)!;
    expect(posted.content).toBe("@coder answer next");
    expect(chat.app.sessions.send(posted.sendId)?.kind).toBe("post");
    expect(chat.app.sessions.queue.waiting(channelId)).toEqual([]);
    const independent = await summon("reviewer");
    expect(chat.app.runner.registry.inSession(channelId)).toHaveLength(2);
    first.script.reply("first");
    const next = await chat.scripted.reached(3);
    const resumed = chat.app.runner.registry
      .inSession(channelId)
      .find((send) => send.policy.agentName === "coder")!;
    expect(resumed.id).not.toBe(first.send.id);
    expect(resumed.firstMessageId).toBe(posted.id);
    expect(chat.app.sessions.send(resumed.id)?.firstMessageId).toBe(posted.id);
    expect(chat.app.sessions.message(posted.id)).toEqual(posted);
    expect(chat.app.sessions.pending.ofSession(channelId)).toEqual([]);
    expect(chat.app.sessions.byId(channelId)?.status).toBe("running");
    independent.script.reply("independent");
    next.reply("next");
    await idle(chat.app);
    expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
  });

  test("the channel cap holds, and raising it wakes one turn per idle agent", async () => {
    const { chat, channelId, post, summon } = await setup();
    await setLimits(chat, { sendsPerChannel: 1 });
    const first = await summon("coder");
    await chat.makeAgent({ name: "third", model: FLASH });
    expect((await post("@reviewer one")).status).toBe(202);
    expect((await post("@reviewer two")).status).toBe(202);
    expect((await post("@third three")).status).toBe(202);
    expect(chat.scripted.scripts).toHaveLength(1);
    await setLimits(chat, { sendsPerChannel: 3 });
    const second = await chat.scripted.reached(2);
    const third = await chat.scripted.reached(3);
    expect(chat.app.runner.registry.inSession(channelId)).toHaveLength(3);
    expect(chat.app.sessions.pending.ofSession(channelId)).toHaveLength(1);
    second.reply("reviewed");
    const fourth = await chat.scripted.reached(4);
    expect(chat.app.runner.registry.inSession(channelId)).toHaveLength(3);
    first.script.reply("first");
    third.reply("third");
    fourth.reply("fourth");
    await idle(chat.app);
    expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
  });

  test("the summoner's user cap queues a different agent but not an admin's turn", async () => {
    const { chat, channelId, post, summon } = await setup();
    await setLimits(chat, { sendsPerUser: 1 });
    const first = await summon("coder");
    expect((await post("@reviewer waiting")).status).toBe(202);
    await chat.makeAgent({ name: "third", model: FLASH });
    const admin = await summon("third", chat.admin);
    first.script.reply("free");
    const next = await chat.scripted.reached(3);
    const resumed = chat.app.runner.registry
      .inSession(channelId)
      .find((send) => send.policy.agentName === "reviewer")!;
    expect(resumed.startedBy).toBe(chat.memberId);
    admin.script.reply("admin");
    next.reply("member");
    await idle(chat.app);
  });

  test("a capped summoner does not block another summoner of the same idle agent", async () => {
    const { chat, channelId, post, summon } = await setup();
    await setLimits(chat, { sendsPerUser: 1 });
    const held = await startChat(chat);
    expect((await post("@reviewer member waits")).status).toBe(202);
    const waiting = chat.app.sessions.pending.ofSession(channelId)[0]!;
    const admin = await summon("reviewer", chat.admin);
    expect(admin.send.startedBy).toBe(chat.adminId);
    expect(chat.app.sessions.pending.ofSession(channelId)).toEqual([waiting]);
    admin.script.reply("admin done");
    await admin.send.drained;
    expect(chat.app.sessions.pending.ofSession(channelId)).toEqual([waiting]);
    held.script.reply("member free");
    const resumed = await chat.scripted.reached(3);
    expect(chat.app.runner.registry.inSession(channelId)[0]).toMatchObject({
      startedBy: chat.memberId,
      firstMessageId: waiting.messageId,
    });
    resumed.reply("member done");
    await idle(chat.app);
  });

  test.each(["agent", "channel"] as const)(
    "a wake prepares no waiting turns behind a full %s",
    async (cap) => {
      const { chat, channelId, post, summon } = await setup();
      await setLimits(chat, { sendsPerChannel: cap === "agent" ? 2 : 1 });
      const first = await summon("coder");
      const agent = cap === "agent" ? "coder" : "reviewer";
      for (let i = 0; i < 5; i++) {
        expect((await post(`@${agent} waiting ${i}`)).status).toBe(202);
      }
      const message = spyOn(chat.app.sessions, "message");
      const memory = spyOn(chat.app.memory, "read");
      try {
        chat.app.runner.queue.wake();
        expect(message).not.toHaveBeenCalled();
        expect(memory).not.toHaveBeenCalled();
        expect(chat.app.sessions.pending.ofSession(channelId)).toHaveLength(5);
        expect(chat.scripted.scripts).toHaveLength(1);
      } finally {
        message.mockRestore();
        memory.mockRestore();
      }
      for (const turn of chat.app.sessions.pending.ofSession(channelId)) {
        await chat.member.call(
          "DELETE",
          `/api/sessions/${channelId}/pending/${turn.id}`,
        );
      }
      first.script.reply("done");
      await idle(chat.app);
    },
  );

  test.each([
    { error: new BadRequest("the turn cannot start"), reason: "failed" },
    { error: new NotFound("no such project"), reason: null },
  ])(
    "a refused start answers its reason: $error.message",
    async ({ error, reason }) => {
      const { chat, channelId } = await setup();
      const create = spyOn(chat.app.sessions, "createSend").mockImplementation(
        () => {
          throw error;
        },
      );
      try {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${channelId}/messages`,
          { body: { message: "@coder cannot start" } },
        );
        expect(response.status).toBe(error.status);
        expect(await response.json()).toEqual({ error: error.message });
        expect(chat.app.sessions.messages(channelId)).toMatchObject([
          { kind: "user", content: "@coder cannot start", status: "done" },
        ]);
        const pending = chat.app.sessions.pending.ofSession(channelId);
        if (reason === null) expect(pending).toEqual([]);
        else expect(pending).toMatchObject([{ reason }]);
        expect(chat.app.runner.registry.inSession(channelId)).toEqual([]);
        expect(chat.scripted.scripts).toHaveLength(0);
      } finally {
        create.mockRestore();
      }
    },
  );

  test("a removed pending turn without a running send never answers started", async () => {
    const { chat, channelId, summon } = await setup();
    const other = await summon("reviewer");
    const changed = spyOn(chat.app.runner.queue, "changed").mockImplementation(
      () => {
        const turn = chat.app.sessions.pending.ofSession(channelId)[0]!;
        chat.app.sessions.pending.remove(turn.id);
      },
    );
    try {
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${channelId}/messages`,
        { body: { message: "@coder cancelled" } },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "the channel turn is no longer pending or running",
      });
      expect(chat.app.sessions.messages(channelId)).toHaveLength(3);
      expect(chat.app.runner.registry.inSession(channelId)).toEqual([
        other.send,
      ]);
    } finally {
      changed.mockRestore();
    }
    other.script.reply("done");
    await idle(chat.app);
  });

  test("stop names a turn and only its summoner or an admin may stop it", async () => {
    const { chat, project, channelId, summon } = await setup();
    const outsider = chat.app.createUser({
      username: "another",
      fullName: "Another",
      email: "another@example.test",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    const added = await chat.admin.call(
      "POST",
      `/api/projects/${project.id}/members`,
      { body: { userId: outsider.id } },
    );
    expect(added.status).toBe(201);
    const other = chat.app.client();
    await other.login("another", "pw");
    const first = await summon("coder");
    const second = await summon("reviewer", other);
    const stop = (id: string, client = chat.member) =>
      client.call("POST", `/api/sessions/${channelId}/sends/${id}/stop`);
    expect((await stop(second.send.id)).status).toBe(403);
    expect(
      (await chat.member.call("POST", `/api/sessions/${channelId}/stop`))
        .status,
    ).toBe(409);
    expect((await stop(first.send.id)).status).toBe(200);
    await first.send.drained;
    expect(first.script.aborted).toBe(true);
    expect(second.script.aborted).toBe(false);
    expect(chat.app.sessions.byId(channelId)?.status).toBe("running");
    expect((await stop(second.send.id, chat.admin)).status).toBe(200);
    await second.send.drained;
    expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
    expect(chat.app.sessions.send(first.send.id)?.cause).toBe("stop");
    expect(chat.app.sessions.send(second.send.id)?.cause).toBe("stop");
  });

  test("pending turns can be cancelled, never edited or deleted as queued texts", async () => {
    const { chat, channelId, detail, post, summon } = await setup();
    const first = await summon("coder");
    const waiting = await post("@coder later", chat.admin);
    expect(waiting.status).toBe(202);
    const turn = (await detail()).pending![0]!;
    const path = `/api/sessions/${channelId}`;
    expect(
      (await chat.member.call("DELETE", `${path}/pending/${turn.id}`)).status,
    ).toBe(403);
    for (const method of ["PATCH", "DELETE"]) {
      const result = await chat.admin.call(
        method,
        `${path}/queued/${turn.id}`,
        {
          body:
            method === "PATCH"
              ? { revision: 0, message: "changed" }
              : { revision: 0 },
        },
      );
      expect(result.status).toBe(409);
    }
    expect(
      (await chat.admin.call("DELETE", `${path}/pending/${turn.id}`)).status,
    ).toBe(200);
    await post("@coder own");
    const own = (await detail()).pending![0]!;
    expect(
      (await chat.member.call("DELETE", `${path}/pending/${own.id}`)).status,
    ).toBe(200);
    await post("@coder admin cancels");
    const byAdmin = (await detail()).pending![0]!;
    expect(
      (await chat.admin.call("DELETE", `${path}/pending/${byAdmin.id}`)).status,
    ).toBe(200);
    expect(chat.app.sessions.message(turn.messageId)?.content).toBe(
      "@coder later",
    );
    expect(chat.app.sessions.message(own.messageId)?.content).toBe(
      "@coder own",
    );
    first.script.reply("done");
    await idle(chat.app);
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(
      (await chat.member.call("DELETE", `${path}/pending/${own.id}`)).status,
    ).toBe(409);
  });

  test("the waiting cap is per channel and a plain post never queues", async () => {
    const { chat, channelId, post, summon } = await setup();
    await setLimits(chat, { queuedPerUser: 32 });
    const first = await summon("coder");
    for (let i = 0; i < MAX_QUEUED_PER_CHAT; i++) {
      expect((await post(`@coder turn ${i}`)).status).toBe(202);
    }
    const before = chat.app.sessions.messages(channelId).length;
    expect((await post("@coder overflow")).status).toBe(429);
    expect(chat.app.sessions.messages(channelId)).toHaveLength(before);
    expect((await post("just a post")).status).toBe(201);
    expect(chat.app.sessions.pending.ofSession(channelId)).toHaveLength(
      MAX_QUEUED_PER_CHAT,
    );
    for (const pending of chat.app.sessions.pending.ofSession(channelId)) {
      await chat.member.call(
        "DELETE",
        `/api/sessions/${channelId}/pending/${pending.id}`,
      );
    }
    first.script.reply("done");
    await idle(chat.app);
  });

  test("interleaved tool rounds keep each send's rows and results together", async () => {
    const { chat, channelId, summon } = await setup();
    const first = await summon("coder");
    const second = await summon("reviewer");
    first.script.toolRound([{ id: "same", name: "datetime", arguments: "{}" }]);
    first.script.end();
    const nextA = await chat.scripted.reached(3);
    second.script.toolRound([
      { id: "same", name: "datetime", arguments: "{}" },
    ]);
    second.script.end();
    const nextB = await chat.scripted.reached(4);
    for (const [next, send] of [
      [nextA, first.send],
      [nextB, second.send],
    ] as const) {
      const messages = next.body.messages as {
        role: string;
        tool_call_id?: string;
      }[];
      expect(messages.filter((row) => row.role === "tool")).toHaveLength(1);
      expect(
        chat.app.sessions
          .messages(channelId)
          .filter((row) => row.sendId === send.id && row.kind === "tool"),
      ).toHaveLength(1);
    }
    nextB.reply("second ends first");
    await second.send.drained;
    expect(chat.app.sessions.byId(channelId)?.status).toBe("running");
    nextA.reply("first ends last");
    await idle(chat.app);
  });

  test.serial(
    "a watch carries every live tail and drops only the send that ended",
    async () => {
      const { chat, channelId, summon } = await setup();
      const conn = await watcher(chat);
      watch(chat, conn, channelId);
      expect(frames(conn, "watched").at(-1)?.live).toEqual([]);
      const first = await summon("coder");
      const second = await summon("reviewer");
      const deltaA = nextFrame(
        conn,
        (frame) => frame.type === "delta" && frame.sendId === first.send.id,
      );
      first.script.content("one");
      await deltaA;
      const deltaB = nextFrame(
        conn,
        (frame) => frame.type === "delta" && frame.sendId === second.send.id,
      );
      second.script.content("two");
      await deltaB;
      watch(chat, conn, channelId);
      expect(frames(conn, "watched").at(-1)?.live).toEqual([
        expect.objectContaining({ sendId: first.send.id, content: "one" }),
        expect.objectContaining({ sendId: second.send.id, content: "two" }),
      ]);
      first.script.finish();
      first.script.usage();
      first.script.end();
      await first.send.drained;
      watch(chat, conn, channelId);
      expect(
        frames(conn, "watched")
          .at(-1)
          ?.live.map((send) => send.sendId),
      ).toEqual([second.send.id]);
      second.script.finish();
      second.script.usage();
      second.script.end();
      await idle(chat.app);
      chat.app.socket.dispose();
    },
  );

  test("email caps belong to each send, even with identical start times", async () => {
    const { chat, channelId, summon } = await setup();
    await chat.app.email.stop();
    expect(
      (
        await chat.admin.call("PUT", "/api/admin/smtp", {
          body: { ...SMTP, username: null, keyName: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await chat.admin.call("PATCH", "/api/tools/email_user", {
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);
    chat.app.users.setEmailFromAgents(chat.memberId, true);
    const first = await summon("coder");
    const second = await summon("reviewer");
    expect(first.send.startedAt).toBe(second.send.startedAt);
    let count = 2;
    for (const turn of [first, second]) {
      turn.script.toolRound(
        Array.from({ length: 6 }, (_, i) => ({
          id: `email${i}`,
          name: "email_user",
          arguments: JSON.stringify({
            to: ["casey"],
            subject: `Notice ${i}`,
            body: "Requested email.",
          }),
        })),
      );
      turn.script.end();
      const next = await chat.scripted.reached(++count);
      const results = (
        next.body.messages as { role: string; content: string }[]
      ).filter((row) => row.role === "tool");
      expect(
        results.filter((row) => row.content.includes("Email queued")),
      ).toHaveLength(5);
      expect(results.at(-1)?.content).toContain("email limit reached");
      expect(chat.app.email.store.countSend(turn.send.id, "agent")).toBe(5);
      next.reply("emailed");
      await turn.send.drained;
    }
    expect(chat.app.sessions.byId(channelId)?.status).toBe("done");
  });

  test("memory edits have independent views and record the right agent", async () => {
    const { chat, channelId, summon } = await setup();
    const first = await summon("coder");
    const second = await summon("reviewer");
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from memory_views where session_id = ?",
        )
        .get(channelId)?.n,
    ).toBe(2);
    first.script.toolRound([
      {
        id: "memory-a",
        name: "memory_edit",
        arguments: JSON.stringify({
          action: "set",
          topic: "deploy",
          text: "Use blue.",
        }),
      },
    ]);
    first.script.end();
    const nextA = await chat.scripted.reached(3);
    second.script.toolRound([
      {
        id: "memory-b",
        name: "memory_edit",
        arguments: JSON.stringify({
          action: "set",
          topic: "deploy",
          text: "Use green.",
        }),
      },
    ]);
    second.script.end();
    const nextB = await chat.scripted.reached(4);
    const result = (nextB.body.messages as { role: string; content: string }[])
      .filter((row) => row.role === "tool")
      .at(-1)!;
    expect(result.content).toContain("Use blue.");
    expect(
      chat.app.db
        .query<{ agent_name: string }, [string]>(
          "select agent_name from memory_notes where session_id = ?",
        )
        .get(channelId)?.agent_name,
    ).toBe("coder");
    nextB.reply("conflict respected");
    await second.send.drained;
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from memory_views where session_id = ?",
        )
        .get(channelId)?.n,
    ).toBe(1);
    nextA.reply("saved");
    await idle(chat.app);
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from memory_views where session_id = ?",
        )
        .get(channelId)?.n,
    ).toBe(0);
  });
});
