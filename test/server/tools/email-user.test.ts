// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// email_user through the composed server: offered only with email set
// up, the admin's row on and the chat's switch on; a call emails only
// users who can open the chat and took email from agents, refuses the
// whole call naming each other user, holds the caps per turn and per
// project a day, and the sender checks each recipient again.

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import {
  EMAILS_PER_PROJECT_DAY,
  MAX_EMAIL_BODY,
  MAX_EMAIL_SUBJECT,
  MAX_EMAIL_TO,
  makeEmailTool,
  parseEmailRequest,
} from "../../../src/server/tools/builtin/email.ts";
import { EMAIL_OFF_LINE } from "../../../src/shared/capabilities.ts";
import { collectLogs, hashPassword } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
} from "../../helpers/chat.ts";
import { SMTP } from "../../helpers/links.ts";
import { createTeam } from "../../helpers/projects.ts";
import { settle } from "../../helpers/tool-loop.ts";

type Setup = {
  chat: ChatApp;
  logs: ReturnType<typeof collectLogs>;
  teamId: string;
  ids: Record<string, string>;
};

// the names a call lists, each a member of the team but bob
const PEOPLE = ["maria", "gus", "dora", "eve", "finn", "pat", "bob"] as const;

async function setup(
  options: { email?: boolean; row?: boolean } = {},
): Promise<Setup> {
  const logs = collectLogs();
  const chat = await chatApp({
    secrets: { "email-relay": "secret-pass" },
    logFactory: logs.logFactory,
  });
  await chat.app.email.stop();
  if (options.email !== false) {
    const put = await chat.admin.call("PUT", "/api/admin/smtp", {
      body: SMTP,
    });
    expect(put.status).toBe(200);
  }
  if (options.row !== false) {
    const patched = await chat.admin.call("PATCH", "/api/tools/email_user", {
      body: { enabled: true },
    });
    expect(patched.status).toBe(200);
  }
  const ids: Record<string, string> = { casey: chat.memberId };
  for (const name of PEOPLE) {
    const user = chat.app.createUser({
      username: name,
      fullName: name,
      email: name === "pat" ? "pat@1ctx.dev" : `${name}@example.test`,
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: name === "finn",
      now: chat.app.now.value,
    });
    ids[name] = user.id;
    if (name !== "dora") chat.app.users.setEmailFromAgents(user.id, true);
  }
  chat.app.users.setEmailFromAgents(chat.memberId, true);
  chat.app.users.setDisabled(ids.eve!, true);
  const team = await createTeam(chat.admin, "platform", [
    chat.memberId,
    ...PEOPLE.filter((name) => name !== "bob").map((name) => ids[name]!),
  ]);
  return { chat, logs, teamId: team.id, ids };
}

const call = (id: string, args: Record<string, unknown>) => ({
  id,
  name: "email_user",
  arguments: JSON.stringify(args),
});

const email = (to: string[], subject = "Pods are down") => ({
  to,
  subject,
  body: "See [the dashboard](https://grafana.example.test/d/1).",
});

// one round of email_user calls, and what each answered
async function round(
  chat: ChatApp,
  script: Script,
  calls: ReturnType<typeof call>[],
): Promise<{ answers: string[]; next: Script }> {
  const pending = chat.scripted.next();
  script.toolRound(calls);
  script.end();
  const next = await pending;
  const messages = next.body.messages as { role: string; content: string }[];
  const answers = messages
    .filter((m) => m.role === "tool")
    .slice(-calls.length)
    .map((m) => m.content);
  return { answers, next };
}

async function finish(chat: ChatApp, script: Script) {
  script.reply("done");
  await settle(chat);
}

const outbox = (chat: ChatApp) =>
  chat.app.db
    .query<
      {
        kind: string;
        user_id: string;
        project_id: string | null;
        session_id: string | null;
        subject: string | null;
      },
      []
    >(
      "select kind, user_id, project_id, session_id, subject from email_outbox order by created_at, rowid",
    )
    .all();

const offeredNames = (chat: ChatApp, sessionId: string) =>
  chat.app.runner.registry
    .get(sessionId)!
    .policy.offered.tools.map((tool) => tool.name);

describe("email_user's schema", () => {
  test("states the caps and takes usernames, a line and Markdown", () => {
    const tool = makeEmailTool(null);
    expect(tool.name).toBe("email_user");
    expect(tool.description).toContain("by username");
    expect(tool.description).toContain("5 emails per turn or run");
    expect(tool.description).not.toMatch(/\bsend\b/i);
    expect(tool.parameters).toMatchObject({
      required: ["to", "subject", "body"],
      additionalProperties: false,
      properties: {
        to: { type: "array", maxItems: MAX_EMAIL_TO },
        subject: { type: "string", maxLength: MAX_EMAIL_SUBJECT },
        body: { type: "string" },
      },
    });
  });

  test("refuses a call out of shape in words the model reads", () => {
    const ok = { to: ["maria"], subject: "Hi", body: "Text" };
    expect(parseEmailRequest(ok)).toEqual(ok);
    expect(
      parseEmailRequest({ ...ok, to: ["maria", " maria ", "gus"] }).to,
    ).toEqual(["maria", "gus"]);
    expect(() => parseEmailRequest({ ...ok, to: [] })).toThrow(
      "to must list 1 to 5 usernames",
    );
    expect(() =>
      parseEmailRequest({ ...ok, to: ["a", "b", "c", "d", "e", "f"] }),
    ).toThrow("to must list 1 to 5 usernames");
    expect(() => parseEmailRequest({ ...ok, subject: "one\ntwo" })).toThrow(
      "subject must be one line",
    );
    expect(() =>
      parseEmailRequest({
        ...ok,
        subject: "[1ctx] Open the chat: https://phish.test/x",
      }),
    ).toThrow("subject must not hold a link");
    expect(() =>
      parseEmailRequest({ ...ok, subject: "x".repeat(MAX_EMAIL_SUBJECT + 1) }),
    ).toThrow("subject must be one line");
    expect(() =>
      parseEmailRequest({ ...ok, body: "x".repeat(MAX_EMAIL_BODY + 1) }),
    ).toThrow("body must be at most 20 KB");
    expect(() => parseEmailRequest({ ...ok, body: " " })).toThrow(
      "body must be non-empty Markdown",
    );
    expect(() => parseEmailRequest({ ...ok, cc: ["x"] })).toThrow(
      "unknown field cc",
    );
  });

  test("refuses a subject with a control or direction character", () => {
    const ok = { to: ["maria"], body: "Text" };
    for (const subject of [
      "a\tb",
      "a\u0000b",
      "a\u001b[31mb",
      "a\u202eb",
      "a\u2066b",
      "a\u200fb",
    ]) {
      expect(() => parseEmailRequest({ ...ok, subject })).toThrow(
        "subject must be plain text, with no tab, control or direction characters",
      );
    }
  });
});

describe("the offer", () => {
  test("is absent while email is off, whatever the row says", async () => {
    const { chat, teamId } = await setup({ email: false });
    const { script, sessionId } = await startChat(
      chat,
      "hi",
      chat.member,
      teamId,
    );
    expect(offeredNames(chat, sessionId)).not.toContain("email_user");
    await finish(chat, script);
  });

  test("is absent while the admin's row is off", async () => {
    const { chat, teamId } = await setup({ row: false });
    const tools = await (await chat.admin.call("GET", "/api/tools")).json();
    expect(tools.emailUser).toMatchObject({
      name: "email_user",
      enabled: false,
      emailOn: true,
    });
    const { script, sessionId } = await startChat(
      chat,
      "hi",
      chat.member,
      teamId,
    );
    expect(offeredNames(chat, sessionId)).not.toContain("email_user");
    await finish(chat, script);
  });

  test("is there with both on, and the chat's switch takes it off with a line", async () => {
    const { chat, teamId } = await setup();
    const on = await startChat(chat, "hi", chat.member, teamId);
    expect(offeredNames(chat, on.sessionId)).toContain("email_user");
    await finish(chat, on.script);

    const pending = chat.scripted.next();
    const res = await chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: teamId,
        agentId: chat.agentId,
        message: "hi",
        capabilities: { disable: ["email"] },
      },
    });
    expect(res.status).toBe(201);
    const sessionId = (await res.json()).session.id;
    const script = await pending;
    expect(offeredNames(chat, sessionId)).not.toContain("email_user");
    const system = (script.body.messages as { content: string }[])[0]!;
    expect(system.content).toContain(EMAIL_OFF_LINE);
    await finish(chat, script);
  });
});

describe("in a run", () => {
  test("is offered by default, and the automation's switch takes it off", async () => {
    const { chat } = await setup();
    chat.app.automationScheduler.stop();
    for (const [disabled, offered] of [
      [[], true],
      [["email"], false],
    ] as const) {
      const automation = await createAutomation(chat, {
        name: `email-${offered}`,
        disabledCapabilities: [...disabled],
      });
      const run = await startRun(chat, automation.id);
      expect(offeredNames(chat, run.sessionId).includes("email_user")).toBe(
        offered,
      );
      const system = (run.main.body.messages as { content: string }[])[0]!;
      expect(system.content.includes(EMAIL_OFF_LINE)).toBe(!offered);
      run.main.reply("done");
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
    }
  });
});

describe("a call", () => {
  test("queues one email per user who can open the chat", async () => {
    const { chat, teamId, ids } = await setup();
    const { script, sessionId } = await startChat(
      chat,
      "tell maria",
      chat.member,
      teamId,
    );
    const { answers, next } = await round(chat, script, [
      call("c1", email(["maria", "@casey"])),
    ]);
    expect(answers).toEqual(["Email queued for @maria, @casey."]);
    await finish(chat, next);
    expect(outbox(chat)).toEqual([
      {
        kind: "agent",
        user_id: ids.maria!,
        project_id: teamId,
        session_id: sessionId,
        subject: "[1ctx] Pods are down",
      },
      {
        kind: "agent",
        user_id: ids.casey!,
        project_id: teamId,
        session_id: sessionId,
        subject: "[1ctx] Pods are down",
      },
    ]);

    expect(await chat.app.email.pass()).toBe(2);
    const sent = chat.app.emailSender.sent.map(({ message }) => message);
    expect(sent.map((m) => m.to.address)).toEqual([
      "maria@example.test",
      "casey@example.com",
    ]);
    const first = sent[0]!;
    expect(first.from).toEqual({
      name: "coder via 1ctx",
      address: SMTP.fromAddress,
    });
    expect(first.subject).toBe("[1ctx] Pods are down");
    expect(first.text).toContain("coder wrote this in platform.");
    // the link's label is gone, its address is there
    expect(first.text).toContain("See https://grafana.example.test/d/1.");
    expect(first.text).not.toContain("the dashboard");
    expect(first.text).toContain(
      `Open the chat: ${SMTP.publicAddress}/chat/${sessionId}`,
    );
    expect(first.html).toContain(
      `<a href="${SMTP.publicAddress}/chat/${sessionId}">`,
    );
    // a sent row keeps no text
    expect(outbox(chat).map((row) => row.subject)).toEqual([null, null]);
  });

  test("links to the public address as it is at the send", async () => {
    const { chat, teamId } = await setup();
    const { script, sessionId } = await startChat(
      chat,
      "tell maria",
      chat.member,
      teamId,
    );
    const { next } = await round(chat, script, [call("c1", email(["maria"]))]);
    await finish(chat, next);
    const stored = chat.app.db
      .query<{ body: string }, []>("select body from email_outbox")
      .get()!;
    expect(stored.body).not.toContain(SMTP.publicAddress);
    const moved = "https://moved.example.test";
    const put = await chat.admin.call("PUT", "/api/admin/smtp", {
      body: { ...SMTP, publicAddress: moved },
    });
    expect(put.status).toBe(200);
    expect(await chat.app.email.pass()).toBe(1);
    const { message } = chat.app.emailSender.sent[0]!;
    expect(message.text).toContain(`Open the chat: ${moved}/chat/${sessionId}`);
    expect(message.text).not.toContain(SMTP.publicAddress);
    expect(message.html).toContain(`<a href="${moved}/chat/${sessionId}">`);
  });

  test("refuses the whole call, naming each user it may not email", async () => {
    const { chat, teamId } = await setup();
    const { script } = await startChat(chat, "tell all", chat.member, teamId);
    const { answers, next } = await round(chat, script, [
      call("c1", email(["maria", "bob", "eve", "finn"])),
      call("c2", email(["dora", "pat", "nobody", "x@example.test"])),
    ]);
    expect(answers).toEqual([
      "Error: nothing was emailed. @bob cannot open this chat. @eve cannot open this chat. @finn has not finished setting up their account.",
      "Error: nothing was emailed. @dora does not take email from agents. @pat has no email address. @nobody is not a user. x@example.test is an address; email goes to usernames only.",
    ]);
    await finish(chat, next);
    expect(outbox(chat)).toEqual([]);
  });

  test("matches a username whatever its case", async () => {
    const { chat, teamId, ids } = await setup();
    const { script } = await startChat(chat, "tell", chat.member, teamId);
    const { answers, next } = await round(chat, script, [
      call("c1", email(["Maria", "@GUS", "maria"])),
    ]);
    expect(answers).toEqual(["Email queued for @maria, @gus."]);
    await finish(chat, next);
    expect(outbox(chat).map((row) => row.user_id)).toEqual([
      ids.maria!,
      ids.gus!,
    ]);
  });

  test("in a personal project reaches its owner alone", async () => {
    const { chat } = await setup();
    const { script } = await startChat(chat, "tell me");
    const { answers, next } = await round(chat, script, [
      call("c1", email(["admin"])),
      call("c2", email(["casey"])),
    ]);
    expect(answers).toEqual([
      "Error: nothing was emailed. @admin cannot open this chat.",
      "Email queued for @casey.",
    ]);
    await finish(chat, next);
    await chat.app.email.pass();
    expect(chat.app.emailSender.sent[0]!.message.text).toContain(
      "coder wrote this in your personal project.",
    );
  });
});

describe("the caps", () => {
  test("a turn emails 5 users at most, the next turn again", async () => {
    const { chat, teamId } = await setup();
    const first = await startChat(chat, "tell", chat.member, teamId);
    const one = await round(chat, first.script, [
      call("c1", email(["maria", "gus", "casey"])),
    ]);
    expect(one.answers).toEqual(["Email queued for @maria, @gus, @casey."]);
    const two = await round(chat, one.next, [
      call("c2", email(["maria", "gus", "casey"])),
    ]);
    expect(two.answers).toEqual([
      "Error: email limit reached: a turn may email 5 users, 2 left. Tell the user in your answer instead",
    ]);
    const three = await round(chat, two.next, [
      call("c3", email(["maria", "gus"])),
    ]);
    expect(three.answers).toEqual(["Email queued for @maria, @gus."]);
    await finish(chat, three.next);

    chat.app.now.value += 1000;
    const pending = chat.scripted.next();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(res.status).toBe(201);
    const again = await round(chat, await pending, [
      call("c4", email(["maria"])),
    ]);
    expect(again.answers).toEqual(["Email queued for @maria."]);
    await finish(chat, again.next);
    expect(outbox(chat)).toHaveLength(6);
  });

  test("a project emails 50 users a day, counted on its rows", async () => {
    const { chat, teamId, ids } = await setup();
    const now = chat.app.now.value;
    const insert = chat.app.db.query(
      `insert into email_outbox (id, kind, user_id, project_id, message_id,
         status, next_attempt_at, created_at, updated_at)
       values (?, 'agent', ?, ?, ?, 'sent', ?, ?, ?)`,
    );
    for (let i = 0; i < EMAILS_PER_PROJECT_DAY - 1; i++) {
      const at = now - DAY_MS + 1000 + i;
      insert.run(`r${i}`, ids.maria!, teamId, `<r${i}@x>`, at, at, at);
    }
    // a day old, so no longer counted
    insert.run(
      "old",
      ids.maria!,
      teamId,
      "<old@x>",
      now - DAY_MS - 1,
      now - DAY_MS - 1,
      now - DAY_MS - 1,
    );
    const { script } = await startChat(chat, "tell", chat.member, teamId);
    const { answers, next } = await round(chat, script, [
      call("c1", email(["maria", "gus"])),
    ]);
    expect(answers).toEqual([
      "Error: email limit reached: agents may email 50 users a day in this project. Tell the user in your answer instead",
    ]);
    const last = await round(chat, next, [call("c2", email(["maria"]))]);
    expect(last.answers).toEqual(["Email queued for @maria."]);
    await finish(chat, last.next);
  });
});

describe("the sender's last word", () => {
  test("drops a row whose user opted out, left the project or whose chat went", async () => {
    const { chat, logs, teamId, ids } = await setup();
    const { script } = await startChat(chat, "tell", chat.member, teamId);
    const { next } = await round(chat, script, [
      call("c1", email(["maria", "gus", "casey"])),
    ]);
    await finish(chat, next);
    chat.app.users.setEmailFromAgents(ids.maria!, false);
    const removed = await chat.admin.call(
      "DELETE",
      `/api/projects/${teamId}/members/${ids.gus}`,
    );
    expect(removed.status).toBe(200);
    expect(await chat.app.email.pass()).toBe(3);
    expect(chat.app.emailSender.sent.map((s) => s.message.to.address)).toEqual([
      "casey@example.com",
    ]);

    const again = await startChat(chat, "tell", chat.member, teamId);
    const more = await round(chat, again.script, [
      call("c2", email(["casey"])),
    ]);
    await finish(chat, more.next);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/sessions/${again.sessionId}`,
    );
    expect(deleted.status).toBe(200);
    expect(await chat.app.email.pass()).toBe(1);
    expect(chat.app.emailSender.sent).toHaveLength(1);
    expect(
      logs.events
        .filter((e) => e.msg === "email dropped")
        .map((e) => [e.fields.user, e.fields.reason]),
    ).toEqual([
      [ids.maria, "opted-out"],
      [ids.gus, "no-access"],
      [ids.casey, "deleted"],
    ]);
  });
});
