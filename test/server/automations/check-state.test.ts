// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a check keeps across runs, edits and restarts: its validators,
// its part of the alert, its owner and its restart rerun.

import { describe, expect, test } from "bun:test";
import { alerts } from "../../../src/server/automations/alerts.ts";
import { AutomationStore } from "../../../src/server/automations/store.ts";
import { RunCapacity } from "../../../src/server/runner/index.ts";
import { CHECK_URL, checkHost, testApp } from "../../helpers/app.ts";
import { createAutomation } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  sessionSettled,
  until,
  waitScript,
} from "../../helpers/chat.ts";

const URL_ = `${CHECK_URL}/alerts?token=q1`;

async function checkApp(fields: Parameters<typeof createAutomation>[1] = {}) {
  const host = checkHost();
  const chat = await chatApp({ fetcher: host.fetcher });
  chat.app.automationScheduler.stop();
  const automation = await createAutomation(chat, {
    checkUrl: URL_,
    ...fields,
  });
  return { chat, host, automation };
}

const row = (chat: ChatApp, id: string) => chat.app.automations.byId(id)!;

const makeDue = (chat: ChatApp, id: string) =>
  chat.app.db
    .query("update automations set next_at = ? where id = ?")
    .run(chat.app.now.value, id);

async function fireChecked(chat: ChatApp, id: string) {
  const scheduler = chat.app.automationScheduler;
  expect(await scheduler.fire(id)).toBeNull();
  await scheduler.checked();
  return scheduler.fire(id);
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });

const etag = (chat: ChatApp, id: string) =>
  chat.app.db
    .query<{ check_etag: string | null }, [string]>(
      "select check_etag from automations where id = ?",
    )
    .get(id)!.check_etag;

// past the silence, a 503 opens the check's alert
async function openCheckAlert(
  chat: ChatApp,
  host: ReturnType<typeof checkHost>,
  id: string,
) {
  host.answer(() => new Response("down", { status: 503 }));
  chat.app.now.value += 3_600_000;
  makeDue(chat, id);
  await fireChecked(chat, id);
  expect(row(chat, id).alert?.check).toBe(true);
}

describe("a check's validators", () => {
  test("a shutdown in the memory phase saves none", async () => {
    const { chat, host, automation } = await checkApp({ ownMemory: true });
    host.answer(() => json({ alerts: [1] }, { etag: '"v1"' }));
    makeDue(chat, automation.id);
    const pending = chat.scripted.next();
    const detail = await fireChecked(chat, automation.id);
    (await pending).reply("The check passed.");
    await waitScript(chat.scripted, 2);
    await chat.app.shutdown();
    expect(chat.app.sessions.lastSend(detail!.session.id)?.cause).toBe(
      "finish",
    );
    expect(etag(chat, automation.id)).toBeNull();
  });

  test("a URL changed and changed back during the run saves none", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => json({ alerts: [1] }, { etag: '"v1"' }));
      makeDue(chat, automation.id);
      const pending = chat.scripted.next();
      const detail = await fireChecked(chat, automation.id);
      const script = await pending;
      for (const checkUrl of [`${CHECK_URL}/other`, URL_]) {
        const res = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          {
            body: {
              editRevision: row(chat, automation.id).editRevision,
              checkUrl,
            },
          },
        );
        expect(res.status).toBe(200);
      }
      script.reply("done");
      await sessionSettled(chat.app, detail!.session.id);
      expect(etag(chat, automation.id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a check's owner", () => {
  test("an owner who cannot run the task makes no GET", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response(null, { status: 204 }));
      chat.app.users.setDisabled(chat.memberId, true);
      makeDue(chat, automation.id);
      await chat.app.automationScheduler.fire(automation.id);
      await chat.app.automationScheduler.checked();
      expect(host.calls).toHaveLength(0);
      expect(row(chat, automation.id)).toMatchObject({
        lastEventOutcome: "skipped",
        lastEventReason: "owner unavailable",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a check's part of the alert", () => {
  test("a new answer that could not run closes it", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      await openCheckAlert(chat, host, automation.id);
      const start = chat.app.runner.startRun;
      chat.app.runner.startRun = () => {
        throw new RunCapacity("process", "full");
      };
      host.answer(() => json({ alerts: [1] }));
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      chat.app.runner.startRun = start;
      expect(row(chat, automation.id).alert).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an older run's late close leaves it open", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const at = chat.app.now.value;
      chat.app.db
        .query(
          `insert into sessions (id, project_id, owner_id, agent_id, origin,
             automation_id, title, status, created_at, last_activity_at)
           values ('old1', ?, ?, ?, 'automation', ?, 't', 'done', ?, ?)`,
        )
        .run(
          chat.projectId,
          chat.memberId,
          chat.agentId,
          automation.id,
          at,
          at,
        );
      await openCheckAlert(chat, host, automation.id);
      alerts({
        db: chat.app.db,
        store: new AutomationStore(chat.app.db),
        sessions: chat.app.sessions,
        markAttention: () => true,
      }).undecided("old1");
      expect(row(chat, automation.id).alert).toMatchObject({
        check: true,
        reason: "The check failed: HTTP 503",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a check's restart rerun", () => {
  test("a stale quiet answer leaves it listed, to ask again", async () => {
    const host = checkHost();
    const chat = await chatApp({ fetcher: host.fetcher });
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat, {
      checkUrl: URL_,
      rerunOnRestart: true,
    });
    host.answer(() => json({ alerts: [1] }));
    makeDue(chat, automation.id);
    const pending = chat.scripted.next();
    await fireChecked(chat, automation.id);
    await pending;
    await chat.app.shutdown();
    const gate: { release: (r: Response) => void } = { release: () => {} };
    host.answer(
      () => new Promise<Response>((resolve) => (gate.release = resolve)),
    );
    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
      activate: true,
    });
    try {
      await until(() => host.calls.length === 2);
      // the URL moves while the rerun's GET is out
      next.db
        .query(
          `update automations set check_url = ?,
             edit_revision = edit_revision + 1 where id = ?`,
        )
        .run(`${CHECK_URL}/other`, automation.id);
      host.answer(() => new Response(null, { status: 204 }));
      gate.release(new Response(null, { status: 204 }));
      await next.automationScheduler.checked();
      await next.automationScheduler.pass();
      await until(
        () => next.automations.byId(automation.id)!.lastCheckResult === "204",
      );
      expect(host.calls.map((call) => call.url)).toEqual([
        URL_,
        URL_,
        `${CHECK_URL}/other`,
      ]);
      expect(next.automations.byId(automation.id)!.lastCheckResult).toBe("204");
    } finally {
      await next.shutdown();
    }
  });
});
