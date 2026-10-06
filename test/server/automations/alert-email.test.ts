// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An alert's email: the run that opens an automation's alert queues an
// email to its owner in the transaction that opens it, with the reason
// and a link to the run; a run that joins queues none, and nothing is
// queued for an owner who did not take email from agents or while email
// is off. The sender checks the owner again.

import { describe, expect, test } from "bun:test";
import { alertEmails } from "../../../src/server/automations/alert-email.ts";
import { alerts } from "../../../src/server/automations/alerts.ts";
import type { Enqueue } from "../../../src/server/email/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { markAttention } from "../../../src/server/sessions/attention.ts";
import {
  answerRun,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, type Script } from "../../helpers/chat.ts";
import { SMTP } from "../../helpers/links.ts";

async function setup(
  options: { email?: boolean; optIn?: boolean } = {},
): Promise<ChatApp> {
  const chat = await chatApp({ secrets: { "email-relay": "secret-pass" } });
  chat.app.automationScheduler.stop();
  await chat.app.email.stop();
  if (options.email !== false) {
    const put = await chat.admin.call("PUT", "/api/admin/smtp", {
      body: SMTP,
    });
    expect(put.status).toBe(200);
  }
  if (options.optIn !== false) {
    const res = await chat.member.call("PUT", "/api/profile/email", {
      body: { fromAgents: true },
    });
    expect(res.status).toBe(200);
  }
  return chat;
}

const flag = (reason: string) => (script: Script) => {
  script.toolRound([
    {
      id: "c1",
      name: "needs_attention",
      arguments: JSON.stringify({ reason }),
    },
  ]);
  script.end();
};

async function markedRun(chat: ChatApp, id: string, reason: string) {
  chat.app.now.value += 60_000;
  const run = await startRun(chat, id);
  await answerRun(chat, run.main, "Pods are down.", flag(reason));
  expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
  return run.sessionId;
}

async function cleanRun(chat: ChatApp, id: string) {
  chat.app.now.value += 60_000;
  const run = await startRun(chat, id);
  await answerRun(chat, run.main, "All good.");
  expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
  return run.sessionId;
}

const outbox = (chat: ChatApp) =>
  chat.app.db
    .query<
      {
        kind: string;
        user_id: string;
        project_id: string | null;
        session_id: string | null;
      },
      []
    >(
      "select kind, user_id, project_id, session_id from email_outbox order by created_at, rowid",
    )
    .all();

describe("an alert's email", () => {
  test("goes to the owner when a run opens the alert, not when one joins", async () => {
    const chat = await setup();
    const automation = await createAutomation(chat, {
      name: "nightly",
      attentionMode: "agent",
    });
    const first = await markedRun(chat, automation.id, "podinfo is not ready");
    expect(outbox(chat)).toEqual([
      {
        kind: "alert",
        user_id: chat.memberId,
        project_id: chat.projectId,
        session_id: first,
      },
    ]);
    // joins the open alert: no second email
    await markedRun(chat, automation.id, "still not ready");
    expect(outbox(chat)).toHaveLength(1);

    expect(await chat.app.email.pass()).toBe(1);
    const { message } = chat.app.emailSender.sent[0]!;
    expect(message.to.address).toBe("casey@example.com");
    // the server's own From name, as account emails carry
    expect(message.from.name).toBe(SMTP.fromName);
    expect(message.subject).toBe("[1ctx] nightly needs attention");
    expect(message.text).toContain(
      "The task nightly in your personal project needs attention.",
    );
    expect(message.text).toContain("podinfo is not ready");
    expect(message.text).toContain(
      `Open the run: ${SMTP.publicAddress}/run/${first}`,
    );
    expect(message.html).toContain(
      `<a href="${SMTP.publicAddress}/run/${first}">`,
    );

    // closed by a clean run, then opened again: a second email
    await cleanRun(chat, automation.id);
    const third = await markedRun(chat, automation.id, "down again");
    expect(outbox(chat).map((row) => row.session_id)).toEqual([first, third]);
  });

  test("is queued in the transaction that opens it, a decider's with no reason", async () => {
    const chat = await setup();
    const automation = await createAutomation(chat, {
      name: "nightly",
      attentionMode: "agent",
    });
    const run = await cleanRun(chat, automation.id);
    const queued: { inside: boolean; fields: Enqueue }[] = [];
    // the composed area registered the kind; this one's outbox records
    const emails = alertEmails({
      log: silent,
      outbox: {
        enabled: () => true,
        link: (path) => `${SMTP.publicAddress}${path}`,
        enqueue: (fields) => {
          queued.push({ inside: chat.app.db.inTransaction, fields });
          return [];
        },
        register: () => {},
      },
      users: chat.app.users,
      canOpen: () => true,
      projects: chat.app.projects,
      reason: (id) => chat.app.sessions.byId(id)?.attentionReason ?? null,
    });
    const word = alerts({
      db: chat.app.db,
      store: chat.app.automations,
      sessions: chat.app.sessions,
      markAttention: (sessionId, attention, by) =>
        markAttention(chat.app.db, chat.app.sessions, sessionId, attention, by),
      emails,
    });
    expect(word.decided(run, 0.9, "judge")).toBeTrue();
    expect(queued.map((q) => q.inside)).toEqual([true]);
    const { fields } = queued[0]!;
    expect(fields).toMatchObject({
      kind: "alert",
      userId: chat.memberId,
      projectId: chat.projectId,
      sessionId: run,
      subject: "[1ctx] nightly needs attention",
    });
    expect(JSON.parse(fields.body!).text).toContain(
      "A decider marked its run.",
    );
  });

  test("nothing is queued for an owner who did not opt in", async () => {
    const chat = await setup({ optIn: false });
    const automation = await createAutomation(chat, {
      attentionMode: "agent",
    });
    await markedRun(chat, automation.id, "podinfo is not ready");
    expect(outbox(chat)).toEqual([]);
  });

  test("nothing is queued while email is off", async () => {
    const chat = await setup({ email: false });
    const automation = await createAutomation(chat, {
      attentionMode: "agent",
    });
    await markedRun(chat, automation.id, "podinfo is not ready");
    expect(outbox(chat)).toEqual([]);
  });

  test("the sender drops it when the owner opted out since", async () => {
    const chat = await setup();
    const automation = await createAutomation(chat, {
      attentionMode: "agent",
    });
    await markedRun(chat, automation.id, "podinfo is not ready");
    expect(outbox(chat)).toHaveLength(1);
    const res = await chat.member.call("PUT", "/api/profile/email", {
      body: { fromAgents: false },
    });
    expect(res.status).toBe(200);
    expect(await chat.app.email.pass()).toBe(1);
    expect(chat.app.emailSender.sent).toEqual([]);
    expect(outbox(chat)).toEqual([]);
  });
});
