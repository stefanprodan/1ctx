// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run a restart cut starts again at the next start when its automation
// asks: once, as the owner, with source restart, through the checks and
// the cap waits of a scheduled fire.

import { describe, expect, test } from "bun:test";
import type { Limits } from "../../../src/server/limits/index.ts";
import { type Event, RunCapacity } from "../../../src/server/runner/index.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import {
  automationBody,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

// a member's automation whose Run now is cut by a shutdown; finish
// answers the run first, so it ends done instead
async function cut(
  fields: {
    rerunOnRestart?: boolean;
    team?: boolean;
    finish?: boolean;
    limits?: Partial<Limits>;
  } = {},
) {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  await tick();
  if (fields.limits) await setLimits(chat, fields.limits);
  let projectId = chat.projectId;
  if (fields.team) {
    projectId = "restart-team";
    chat.app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values (?, 'team', ?, ?, ?)",
      )
      .run(projectId, projectId, chat.adminId, chat.app.now.value);
    chat.app.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values (?, ?, ?)",
      )
      .run(projectId, chat.memberId, chat.app.now.value);
  }
  const response = await chat.member.call(
    "POST",
    `/api/projects/${projectId}/automations`,
    {
      body: {
        ...automationBody(chat),
        ...(fields.rerunOnRestart === undefined
          ? {}
          : { rerunOnRestart: fields.rerunOnRestart }),
      },
    },
  );
  expect(response.status).toBe(201);
  const automation: AutomationSummary = (await response.json()).automation;
  const run = await startRun(chat, automation.id);
  if (fields.finish) {
    run.main.reply("done");
    await settleRun(chat, run.sessionId);
  }
  await chat.app.shutdown();
  return { chat, automation, sessionId: run.sessionId };
}

const restart = (chat: ChatApp, activate = true) =>
  testApp({ db: chat.app.db, fetcher: chat.scripted.fetcher, activate });

// the restart run, answered and ended, then the app
async function finish(next: TestApp, chat: ChatApp, id: string) {
  const sessionId = next.automations.byId(id)!.lastRunSessionId!;
  chat.scripted.scripts.at(-1)!.reply("done");
  for (let i = 0; i < 200; i++) {
    if (next.sessions.byId(sessionId)?.status !== "running") break;
    await tick();
  }
  await next.shutdown();
}

// startRun refusing with a full process cap until the test lets it go
function fullCap(next: TestApp) {
  const state = { full: true, events: [] as Event[] };
  const original = next.runner.startRun;
  next.runner.startRun = (event) => {
    state.events.push(event);
    if (state.full) {
      throw new RunCapacity(
        "process",
        "Too many chats and runs are going. Try again in a moment.",
      );
    }
    return original(event);
  };
  return {
    state,
    restore() {
      next.runner.startRun = original;
    },
  };
}

// a pass after the start's own, then nothing new may have started
async function nothingExtra(
  next: TestApp,
  chat: ChatApp,
  automation: AutomationSummary,
  sessionId: string,
) {
  await next.automationScheduler.pass();
  await tick();
  expect(chat.scripted.scripts).toHaveLength(1);
  const row = next.automations.byId(automation.id)!;
  expect(row.lastRunSessionId).toBe(sessionId);
  expect(row.nextAt).toBe(automation.nextAt);
  return row;
}

describe("the re-fire at start", () => {
  test("a run cut by the shutdown starts once again, as the owner", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
    });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("stopped");
    expect(chat.app.sessions.lastSend(sessionId)!.cause).toBe("shutdown");

    const next = await restart(chat);
    await waitScript(chat.scripted, 2);
    const row = next.automations.byId(automation.id)!;
    expect(row).toMatchObject({
      lastEventSource: "restart",
      lastEventOutcome: "run",
      lastEventReason: null,
      lastRunStatus: "running",
      nextAt: automation.nextAt,
    });
    expect(row.lastRunSessionId).not.toBe(sessionId);
    expect(next.sessions.byId(row.lastRunSessionId!)).toMatchObject({
      origin: "automation",
      automationId: automation.id,
      runSource: "restart",
      ownerId: chat.memberId,
    });
    // the cut run stays in the log as stopped
    expect(next.sessions.byId(sessionId)!.status).toBe("stopped");
    await next.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(2);
    await finish(next, chat, automation.id);
  });

  test("a run a crash left running, ended by the repair, starts again too", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
    });
    // as the process left it when it died mid-run
    chat.app.db.exec(`
      update sessions set status = 'running' where id = '${sessionId}';
      update sends set status = 'running', cause = null, finished_at = null
        where session_id = '${sessionId}';
      update automations set last_run_status = 'running'
        where id = '${automation.id}';
    `);
    const next = await restart(chat);
    await waitScript(chat.scripted, 2);
    expect(next.sessions.lastSend(sessionId)!.cause).toBe("restart");
    const row = next.automations.byId(automation.id)!;
    expect(row.lastEventSource).toBe("restart");
    expect(next.sessions.byId(row.lastRunSessionId!)!.runSource).toBe(
      "restart",
    );
    await finish(next, chat, automation.id);
  });

  test("without the flag the cut run stays cut", async () => {
    const { chat, automation, sessionId } = await cut();
    expect(chat.app.automations.byId(automation.id)!.rerunOnRestart).toBe(
      false,
    );
    const next = await restart(chat);
    const row = await nothingExtra(next, chat, automation, sessionId);
    expect(row.lastEventSource).toBe("manual");
    await next.shutdown();
  });

  test("a suspended automation starts nothing", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
    });
    chat.app.db
      .query(
        "update automations set suspended_at = ?, next_at = null where id = ?",
      )
      .run(chat.app.now.value, automation.id);
    const next = await restart(chat);
    await next.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(next.automations.byId(automation.id)).toMatchObject({
      lastRunSessionId: sessionId,
      lastEventSource: "manual",
    });
    await next.shutdown();
  });

  test("an owner who lost the project starts nothing, the skip recorded", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
      team: true,
    });
    chat.app.db
      .query("delete from memberships where project_id = ? and user_id = ?")
      .run(automation.projectId, chat.memberId);
    const next = await restart(chat);
    const row = await nothingExtra(next, chat, automation, sessionId);
    expect(row).toMatchObject({
      lastEventSource: "restart",
      lastEventOutcome: "skipped",
      lastEventReason: "owner cannot see project",
    });
    await next.shutdown();
  });

  test("a last run that ended done starts nothing", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
      finish: true,
    });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("done");
    const next = await restart(chat);
    const row = await nothingExtra(next, chat, automation, sessionId);
    expect(row.lastEventSource).toBe("manual");
    await next.shutdown();
  });

  test("a row whose fire is due as well starts once, as a restart run", async () => {
    const { chat, automation } = await cut({ rerunOnRestart: true });
    const due = chat.app.now.value;
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(due, automation.id);
    const next = await restart(chat);
    await waitScript(chat.scripted, 2);
    await next.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(2);
    const row = next.automations.byId(automation.id)!;
    expect(row.lastEventSource).toBe("restart");
    expect(row.nextAt).toBeGreaterThan(due);
    await finish(next, chat, automation.id);
  });

  test("a full cap makes it wait, then it fires", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
    });
    const next = await restart(chat, false);
    const cap = fullCap(next);
    // the start lists the cut run and its first pass meets the cap
    next.automationScheduler.start();
    next.automationScheduler.stop();
    expect(cap.state.events).toHaveLength(1);
    await next.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(next.automations.byId(automation.id)!.lastRunSessionId).toBe(
      sessionId,
    );

    cap.state.full = false;
    next.automationScheduler.wake();
    await next.automationScheduler.pass();
    await waitScript(chat.scripted, 2);
    expect(cap.state.events.at(-1)).toMatchObject({
      source: "restart",
      user: { id: chat.memberId },
    });
    expect(next.automations.byId(automation.id)!.lastEventSource).toBe(
      "restart",
    );
    cap.restore();
    await finish(next, chat, automation.id);
  });

  test("the flag turned off while it waits leaves the cut run alone", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
    });
    const next = await restart(chat, false);
    const cap = fullCap(next);
    next.automationScheduler.start();
    next.automationScheduler.stop();
    expect(cap.state.events).toHaveLength(1);
    next.db
      .query("update automations set rerun_on_restart = 0 where id = ?")
      .run(automation.id);

    cap.state.full = false;
    next.automationScheduler.wake();
    await next.automationScheduler.pass();
    await next.automationScheduler.pass();
    await tick();
    expect(cap.state.events).toHaveLength(1);
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(next.automations.byId(automation.id)).toMatchObject({
      lastRunSessionId: sessionId,
      lastEventSource: "manual",
    });
    cap.restore();
    await next.shutdown();
  });

  test("it takes the scheduled share of the caps, not the owner's", async () => {
    const { chat, automation, sessionId } = await cut({
      rerunOnRestart: true,
      limits: { sendsPerUser: 1 },
    });
    const next = await restart(chat, false);
    // the owner's one place is taken by a chat of their own
    const member = next.client();
    await member.login("casey", "pw");
    const pending = chat.scripted.next();
    const started = await member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "a" },
    });
    expect(started.status).toBe(201);
    const held = await pending;

    next.automationScheduler.start();
    next.automationScheduler.stop();
    await waitScript(chat.scripted, 3);
    const row = next.automations.byId(automation.id)!;
    expect(row.lastEventSource).toBe("restart");
    expect(row.lastRunSessionId).not.toBe(sessionId);
    expect(next.sessions.byId(row.lastRunSessionId!)).toMatchObject({
      runSource: "restart",
      ownerId: chat.memberId,
      status: "running",
    });
    held.reply("ok");
    await finish(next, chat, automation.id);
  });
});

describe("the flag on the wire", () => {
  test("is off by default, set on create and by a PATCH", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const plain = await createAutomation(chat);
    expect(plain.rerunOnRestart).toBe(false);
    const asked = await chat.member.call(
      "POST",
      `/api/projects/${chat.projectId}/automations`,
      {
        body: {
          ...automationBody(chat, { name: "asked" }),
          rerunOnRestart: true,
        },
      },
    );
    expect((await asked.json()).automation.rerunOnRestart).toBe(true);
    const patched = await chat.member.call(
      "PATCH",
      `/api/automations/${plain.id}`,
      {
        body: {
          editRevision: chat.app.automations.byId(plain.id)!.editRevision,
          rerunOnRestart: true,
        },
      },
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).automation).toMatchObject({
      rerunOnRestart: true,
      nextAt: plain.nextAt,
    });
    expect(chat.app.automations.byId(plain.id)!.rerunOnRestart).toBe(true);
    const off = await chat.member.call(
      "PATCH",
      `/api/automations/${plain.id}`,
      {
        body: {
          editRevision: chat.app.automations.byId(plain.id)!.editRevision,
          rerunOnRestart: false,
        },
      },
    );
    expect((await off.json()).automation.rerunOnRestart).toBe(false);
    const bad = await chat.member.call(
      "PATCH",
      `/api/automations/${plain.id}`,
      {
        body: {
          editRevision: chat.app.automations.byId(plain.id)!.editRevision,
          rerunOnRestart: "yes",
        },
      },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: "rerunOnRestart must be boolean",
    });
    await chat.app.shutdown();
  });
});
