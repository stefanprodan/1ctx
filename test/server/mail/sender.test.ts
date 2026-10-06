// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The outbox and its sender over a memory db, a fake mailer and a
// clock the test moves: a row is sent and deleted, retried on the
// backoff with one Message-ID, failed for good and swept after a week,
// dropped when its recipient changed, and taken again after a crash.

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { mailArea } from "../../../src/server/mail/index.ts";
import { UserStore } from "../../../src/server/users/index.ts";
import type { PutMailRequest } from "../../../src/shared/api/mail.ts";
import { collectLogs, fakeMailer } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

const SERVER: PutMailRequest = {
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "mail@example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test",
};

const MINUTE = 60_000;

function setup(options: { key?: boolean } = {}) {
  const db = memoryDb();
  let now = 1_000_000;
  const sleepers = new Set<{ at: number; resolve: () => void }>();
  const clock = Object.assign(() => now, {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.add({ at: now + ms, resolve });
      }),
  });
  const move = (ms: number) => {
    now += ms;
    for (const sleeper of [...sleepers]) {
      if (sleeper.at > now) continue;
      sleepers.delete(sleeper);
      sleeper.resolve();
    }
  };
  const users = new UserStore(db);
  const user = users.create({
    username: "ann",
    fullName: "Ann Lee",
    email: "ann@example.test",
    role: "member",
    passwordHash: "x",
    mustChangePassword: false,
    now,
  });
  const fake = fakeMailer();
  const logs = collectLogs();
  const keys: Record<string, string> =
    options.key === false ? {} : { "email-relay": "secret-pass" };
  const mail = mailArea({
    db,
    clock,
    log: logs.logFactory("mail"),
    secret: (name) => keys[name] ?? null,
    keys: () => Object.keys(keys),
    users,
    mailer: fake.mailer,
  });
  mail.store.saveSettings(SERVER, now);
  const enqueue = (over: { subject?: string } = {}) =>
    transact(db, () => {
      const events = mail.enqueue({
        kind: "notice",
        userId: user.id,
        subject: over.subject ?? "Hello",
        body: "Body text",
      });
      return { result: undefined, events };
    });
  const rows = () =>
    db
      .query<
        {
          id: string;
          status: string;
          attempts: number;
          next_attempt_at: number;
          failure: string | null;
          subject: string | null;
          message_id: string;
        },
        []
      >("select * from mail_outbox order by created_at")
      .all();
  return {
    db,
    mail,
    fake,
    logs,
    users,
    user,
    keys,
    enqueue,
    rows,
    move,
    now: () => now,
  };
}

describe("the sender", () => {
  test("sends a row to the user as they are now and deletes it", async () => {
    const t = setup();
    t.enqueue();
    expect(t.rows()).toHaveLength(1);
    expect(await t.mail.pass()).toBe(1);
    expect(t.rows()).toEqual([]);
    expect(t.fake.sent).toHaveLength(1);
    const { server, mail } = t.fake.sent[0]!;
    expect(server).toEqual({
      host: "smtp.example.test",
      port: 465,
      security: "tls",
      username: "api_token",
      password: "secret-pass",
    });
    expect(mail).toMatchObject({
      from: { name: "1ctx", address: "mail@example.test" },
      to: { name: "Ann Lee", address: "ann@example.test" },
      subject: "Hello",
      text: "Body text",
    });
    expect(mail.messageId).toMatch(/^<[^@]+@example\.test>$/);
    const sent = t.logs.events.find((e) => e.msg === "mail sent")!;
    expect(sent.fields).toEqual({
      kind: "notice",
      user: t.user.id,
      mail: expect.any(String),
    });
  });

  test("backs off 1, 5 and 30 minutes with one Message-ID, then fails", async () => {
    const t = setup();
    t.fake.result = "auth";
    t.enqueue();
    const id = t.rows()[0]!.message_id;
    const start = t.now();
    expect(await t.mail.pass()).toBe(1);
    expect(t.rows()[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      next_attempt_at: start + MINUTE,
    });
    // not due yet: nothing is taken
    expect(await t.mail.pass()).toBe(0);
    for (const wait of [MINUTE, 5 * MINUTE, 30 * MINUTE]) {
      t.move(wait);
      expect(await t.mail.pass()).toBe(1);
    }
    expect(t.fake.sent.map((s) => s.mail.messageId)).toEqual([id, id, id, id]);
    expect(t.rows()).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 4,
        failure: "auth",
        subject: null,
      }),
    ]);
    const failed = t.logs.events.filter((e) => e.msg === "mail failed");
    expect(failed.map((e) => e.fields.final)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // the word and the ids, never an address or the text
    expect(JSON.stringify(t.logs.events)).not.toContain("example.test");
    expect(JSON.stringify(t.logs.events)).not.toContain("Hello");
    expect(t.mail.attention()).toMatchObject({
      queued: 0,
      failed: 1,
      lastFailure: "auth",
    });
  });

  test("keeps a failed row a week, then sweeps it", async () => {
    const t = setup();
    t.fake.result = "rejected";
    t.enqueue();
    for (const wait of [0, MINUTE, 5 * MINUTE, 30 * MINUTE]) {
      t.move(wait);
      await t.mail.pass();
    }
    expect(t.rows()[0]?.status).toBe("failed");
    t.move(7 * 24 * 60 * MINUTE - 1);
    expect(t.mail.sweep(t.now())).toBe(0);
    t.move(2);
    expect(t.mail.sweep(t.now())).toBe(1);
    expect(t.rows()).toEqual([]);
  });

  test("drops a row whose user was disabled or has no real address", async () => {
    const t = setup();
    t.enqueue();
    t.users.setDisabled(t.user.id, true);
    expect(await t.mail.pass()).toBe(1);
    t.users.setDisabled(t.user.id, false);
    t.enqueue();
    t.db
      .query("update users set email_placeholder = 1 where id = ?")
      .run(t.user.id);
    expect(await t.mail.pass()).toBe(1);
    expect(t.rows()).toEqual([]);
    expect(t.fake.sent).toEqual([]);
    expect(
      t.logs.events
        .filter((e) => e.msg === "mail dropped")
        .map((e) => e.fields.reason),
    ).toEqual(["disabled", "placeholder"]);
  });

  test("mails the address held at send time", async () => {
    const t = setup();
    t.enqueue();
    t.users.setEmail(t.user.id, "ann.lee@example.test");
    await t.mail.pass();
    expect(t.fake.sent[0]!.mail.to.address).toBe("ann.lee@example.test");
  });

  test("lets a kind veto or write the mail when it is sent", async () => {
    const t = setup();
    const seen: string[] = [];
    t.mail.register("notice", (row, user) => {
      seen.push(user.id);
      return row.subject === "veto"
        ? "opted-out"
        : { subject: "Built now", text: "Fresh" };
    });
    t.enqueue({ subject: "veto" });
    t.enqueue();
    expect(await t.mail.pass()).toBe(2);
    expect(seen).toEqual([t.user.id, t.user.id]);
    expect(t.fake.sent.map((s) => s.mail.subject)).toEqual(["Built now"]);
    expect(() => t.mail.register("notice", () => "gone")).toThrow();
  });

  test("takes a claim left by a dead process after a minute", async () => {
    const t = setup();
    t.enqueue();
    expect(t.mail.store.claim(t.now(), MINUTE)).not.toBeNull();
    expect(await t.mail.pass()).toBe(0);
    t.move(MINUTE);
    expect(await t.mail.pass()).toBe(1);
    expect(t.fake.sent).toHaveLength(1);
  });

  test("waits while mail is off, then sends", async () => {
    const t = setup({ key: false });
    expect(t.mail.enabled()).toBe(false);
    expect(() => t.enqueue()).toThrow("mail is off");
    t.keys["email-relay"] = "secret-pass";
    t.enqueue();
    delete t.keys["email-relay"];
    expect(await t.mail.pass()).toBe(0);
    expect(t.rows()).toHaveLength(1);
    expect(t.mail.attention()).toMatchObject({
      keyName: "email-relay",
      hasKey: false,
      queued: 1,
    });
    t.keys["email-relay"] = "secret-pass";
    expect(await t.mail.pass()).toBe(1);
  });

  test("refuses a subject that is not one line", () => {
    const t = setup();
    expect(() => t.enqueue({ subject: "a\nBcc: b@example.test" })).toThrow();
    expect(t.rows()).toEqual([]);
  });

  test.serial(
    "wakes after the commit, on its timer, and drains on stop",
    async () => {
      const t = setup();
      t.mail.start();
      const settle = async (sent: number) => {
        for (let i = 0; i < 100 && t.fake.sent.length < sent; i++) {
          await Bun.sleep(1);
        }
        expect(t.fake.sent).toHaveLength(sent);
      };
      t.enqueue();
      await settle(1);
      t.fake.result = "timeout";
      t.enqueue();
      await settle(2);
      // the backoff's minute on the clock, not a wake
      t.move(MINUTE);
      await settle(3);
      await t.mail.stop();
      t.fake.result = "sent";
      t.move(5 * MINUTE);
      await Bun.sleep(5);
      expect(t.fake.sent).toHaveLength(3);
      t.mail.dispose();
    },
  );
});
