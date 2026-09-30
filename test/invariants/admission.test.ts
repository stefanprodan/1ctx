// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admission: one send per session, and every chat and run counted per
// user who started it, per project and in the process, decided before
// anything is written, with the refusal naming who holds the lock or
// the narrowest full cap.

import { describe, expect, test } from "bun:test";
import {
  automationBody,
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import {
  chatApp,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { createTeam } from "../helpers/projects.ts";

const PROCESS = "Too many chats and runs are going. Try again in a moment.";

describe("admission", () => {
  // a message waits behind the running turn instead (queue.test.ts)
  test("a second send into a running chat is refused with who is sending", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/regenerate`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Casey Doe is sending" });
    // nothing was written for the refused send
    expect(chat.app.sessions.messages(sessionId)).toHaveLength(2);
    script.reply("ok");
    await tick();
  });

  test("the process cap refuses with a 429 and frees as sends end", async () => {
    const chat = await chatApp();
    await setLimits(chat, { sendsPerProject: 4, sendsRunning: 4 });
    const team = await createTeam(chat.admin, "ops", [chat.memberId]);
    const held = [];
    for (const message of ["a", "b", "c"]) {
      held.push(await startChat(chat, message, chat.admin, team.id));
    }
    const mine = await startChat(chat, "mine");
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: team.id, agentId: chat.agentId, message: "d" },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: PROCESS });
    expect(chat.app.sessions.list([team.id], "").rows).toHaveLength(3);
    held[0]!.script.reply("done");
    await settleRun(chat, held[0]!.sessionId);
    const next = await startChat(chat, "d", chat.member, team.id);
    expect(next.detail.session.status).toBe("running");
    for (const one of [...held.slice(1), mine, next]) one.script.reply("done");
    await tick();
    await chat.app.shutdown();
  });

  test("a user's fifth in any project is refused and their automation's scheduled run still starts", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const team = await createTeam(chat.admin, "ops", [chat.memberId]);
    const going = [
      (await startChat(chat, "one")).script,
      (await startChat(chat, "two")).script,
      (await startChat(chat, "three", chat.member, team.id)).script,
    ];
    const automation = await createAutomation(chat, { name: "four" });
    going.push((await startRun(chat, automation.id)).main);
    for (const projectId of [chat.projectId, team.id]) {
      const refused = await chat.member.call("POST", "/api/sessions", {
        body: { projectId, agentId: chat.agentId, message: "five" },
      });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        error: "You have 4 chats and runs going. Wait for one to end.",
      });
    }
    const other = await createAutomation(chat, { name: "scheduled" });
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, other.id);
    const pending = chat.scripted.next();
    const run = await chat.app.automationScheduler.fire(other.id);
    expect(run?.session.status).toBe("running");
    // the admin is bound by their own count alone
    const theirs = await startChat(chat, "theirs", chat.admin, team.id);
    for (const script of going) script.reply("done");
    (await pending).reply("done");
    theirs.script.reply("done");
    await tick();
    await chat.app.shutdown();
  });

  test("regenerate and compact in a team chat count against the member who asked and the chat's project", async () => {
    const chat = await chatApp();
    await setLimits(chat, { sendsPerUser: 1 });
    const team = await createTeam(chat.admin, "ops", [chat.memberId]);
    const owned = await startChat(chat, "question", chat.admin, team.id);
    owned.script.reply("answer");
    await settleRun(chat, owned.sessionId);
    // the member is at their cap, the chat's owner is not
    const mine = await startChat(chat, "mine");
    const USER = "You have 1 chat or run going. Wait for one to end.";
    for (const action of ["regenerate", "compact"]) {
      const refused = await chat.member.call(
        "POST",
        `/api/sessions/${owned.sessionId}/${action}`,
        { body: {} },
      );
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: USER });
    }
    mine.script.reply("done");
    await settleRun(chat, mine.sessionId);

    for (const action of ["regenerate", "compact"]) {
      const pending = chat.scripted.next();
      const started = await chat.member.call(
        "POST",
        `/api/sessions/${owned.sessionId}/${action}`,
        { body: {} },
      );
      expect(started.status).toBe(action === "compact" ? 200 : 201);
      const script = await pending;
      const send = chat.app.runner.registry.get(owned.sessionId)!;
      expect(send.startedBy).toBe(chat.memberId);
      expect(send.projectId).toBe(team.id);
      // it holds the member's one place, not the owner's
      const other = await chat.member.call("POST", "/api/sessions", {
        body: { projectId: team.id, agentId: chat.agentId, message: "x" },
      });
      expect(await other.json()).toEqual({ error: USER });
      const theirs = await startChat(chat, "theirs", chat.admin, team.id);
      script.reply(action === "compact" ? "## Goal" : "again");
      theirs.script.reply("done");
      await settleRun(chat, owned.sessionId);
      await settleRun(chat, theirs.sessionId);
    }
    await chat.app.shutdown();
  });

  test("Run now counts against whoever pressed it, not the automation's owner", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    await setLimits(chat, { sendsPerUser: 1 });
    const team = await createTeam(chat.admin, "ops", [chat.memberId]);
    const made = async (name: string) => {
      const response = await chat.member.call(
        "POST",
        `/api/projects/${team.id}/automations`,
        { body: automationBody(chat, { name }) },
      );
      expect(response.status).toBe(201);
      return (await response.json()).automation.id as string;
    };
    const first = await made("first");
    const second = await made("second");
    // the owner is at their cap
    const mine = await startChat(chat, "mine");
    const refused = await chat.member.call(
      "POST",
      `/api/automations/${first}/run`,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "You have 1 chat or run going. Wait for one to end.",
    });
    // the admin's press counts against the admin
    const pending = chat.scripted.next();
    const pressed = await chat.admin.call(
      "POST",
      `/api/automations/${first}/run`,
    );
    expect(pressed.status).toBe(201);
    const run = await pending;
    const again = await chat.admin.call(
      "POST",
      `/api/automations/${second}/run`,
    );
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({
      error: "You have 1 chat or run going. Wait for one to end.",
    });
    mine.script.reply("done");
    run.reply("done");
    await tick();
    await chat.app.shutdown();
  });

  test("a full project refuses a member's turn and holds its scheduled runs, other projects go on", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    await setLimits(chat, { sendsPerUser: 2, sendsPerProject: 4 });
    const team = await createTeam(chat.admin, "ops", [chat.memberId]);
    const due = async (name: string, projectId = chat.projectId) => {
      const response = await chat.member.call(
        "POST",
        `/api/projects/${projectId}/automations`,
        { body: automationBody(chat, { name }) },
      );
      const { automation } = await response.json();
      chat.app.db
        .query("update automations set next_at = ? where id = ?")
        .run(chat.app.now.value, automation.id);
      return automation.id as string;
    };
    const runs: string[] = [];
    for (const name of ["r1", "r2", "r3", "r4"]) runs.push(await due(name));
    const elsewhere = await due("elsewhere", team.id);
    await chat.app.automationScheduler.pass();
    // three runs hold the scheduled share of the project, the fourth
    // waits and the team project's run starts
    await waitScript(chat.scripted, 4);
    expect(chat.app.runner.registry.running(4)).toMatchObject({
      scheduled: 4,
      projectsFull: 0,
    });
    const row = (id: string) => chat.app.automations.byId(id)!;
    const waiting = () => runs.filter((id) => row(id).lastEventAt === null);
    expect(waiting()).toHaveLength(1);
    expect(row(elsewhere).lastEventOutcome).toBe("run");
    // a member's chat still starts, and fills the project
    const talk = await startChat(chat, "incident");
    const refused = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "This project has 4 chats and runs going. Try again in a moment.",
    });
    // the team project takes a chat while the full one holds its run
    const teamTalk = await startChat(chat, "team", chat.member, team.id);
    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    expect(waiting()).toHaveLength(1);
    expect(chat.scripted.scripts).toHaveLength(6);
    for (const script of chat.scripted.scripts) script.reply("done");
    await tick();
    expect(talk.detail.session.status).toBe("running");
    expect(teamTalk.detail.session.status).toBe("running");
    await chat.app.shutdown();
  });

  test("an agent that is not there, or a project the caller may not see, is refused before the lock", async () => {
    const chat = await chatApp();
    const noAgent = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: "none", message: "x" },
    });
    expect(noAgent.status).toBe(400);
    const admins = chat.app.projects.personal(chat.adminId)!.id;
    const notMine = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: admins, agentId: chat.agentId, message: "x" },
    });
    expect(notMine.status).toBe(404);
    expect(chat.app.runner.registry.size).toBe(0);
  });

  test("a second message during a work round is refused while the lock is held", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat, "when");
    // the reply moves into the fold at the first call delta; the send is
    // still running, so a regenerate is refused
    script.content("checking");
    script.toolCall({
      id: "c1",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/regenerate`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Casey Doe is sending" });
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    await tick();
    expect(script.aborted).toBe(true);
    chat.app.socket.dispose();
  });

  test("after shutdown nothing is admitted", async () => {
    const chat = await chatApp();
    await chat.app.shutdown();
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    expect(res.status).toBe(409);
  });
});
