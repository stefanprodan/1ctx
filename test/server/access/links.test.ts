// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Asking for a code and a link, and using either, through the composed
// app with the fake email sender and the fake clock: an ask answers the
// same for every account and does its work after the answer, the token
// and the code are minted when the email is sent, a code is tried only
// beside the browser that asked, and a link or its code works once.

import { describe, expect, test } from "bun:test";
import { TOUCH_AFTER_MS } from "../../../src/server/access/index.ts";
import { ASK_TTL_MS } from "../../../src/server/access/link-routes.ts";
import {
  ASKS_PER_CHALLENGE_HOUR,
  ASKS_PER_HOUR,
  ASKS_PER_INBOX_DAY,
  ASKS_PER_USER_DAY,
  BACKOFF_MS,
  SMTP_TIMEOUTS,
} from "../../../src/server/email/index.ts";
import { DAY_MS, HOUR_MS } from "../../../src/server/lib/clock.ts";
import { ADMIN_KEY, ORIGIN, type TestClient } from "../../helpers/app.ts";
import { type EmailApp, emailApp, SMTP } from "../../helpers/links.ts";

const MINUTE = 60_000;

// what an answer shows a caller: the status, the body and the headers
// that could differ; the challenge's value is random, its shape is not
async function shown(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    cookie: res.headers
      .get("set-cookie")
      ?.replace(/^login_ask=[A-Za-z0-9_-]{43};/, "login_ask=<challenge>;"),
    type: res.headers.get("content-type"),
  };
}

const ASKED = {
  status: 202,
  body: "",
  cookie: `login_ask=<challenge>; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=${ASK_TTL_MS / 1000}`,
  type: null,
};

// the user's links as rows: tries and whether used
const rows = (e: EmailApp) =>
  e.app.db
    .query<{ purpose: string; code_tries: number; used: number }, [string]>(
      `select purpose, code_tries, used_at is not null as used
       from user_links where user_id = ? order by created_at, rowid`,
    )
    .all(e.maria.id);

const capped = (e: EmailApp) =>
  e.logs.events
    .filter((ev) => ev.msg === "link ask capped")
    .map((ev) => ev.fields);

const asks = (e: EmailApp) =>
  e.app.db
    .query<{ n: number }, []>("select count(*) as n from link_asks")
    .get()!.n;

// a browser of its own, so the login limit per address never decides
let browsers = 0;
const browser = (e: EmailApp) => {
  const n = browsers++;
  return e.app.client(`10.${Math.floor(n / 250) % 250}.${n % 250}.1`);
};

// a code that is not this one
const other = (code: string) => (code === "000000" ? "111111" : "000000");

describe("asking for a code", () => {
  test("answers 202 with no body and the challenge, before any lookup", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    app.createUser({
      username: "gone",
      fullName: "Gone",
      email: "gone@example.test",
      role: "member",
      disabled: true,
      now: app.now.value,
    });
    app.createUser({
      username: "seeded",
      fullName: "Seeded",
      email: "seeded@1ctx.dev",
      role: "member",
      now: app.now.value,
    });
    const answers = [];
    for (const email of [
      "maria@example.test",
      "gone@example.test",
      "seeded@1ctx.dev",
      "MARIA@example.test",
      "nobody@example.test",
    ]) {
      const res = await e.ask(browser(e), email);
      answers.push(await shown(res));
      // the lookup runs after the answer
      if (email === "maria@example.test") {
        expect(e.outbox(maria.id)).toEqual([]);
      }
    }
    for (const answer of answers) expect(answer).toEqual(ASKED);
    await app.linkAsks();
    // maria's address, as typed and uppercased: two links, both live
    expect(e.outbox(maria.id)).toEqual([
      { kind: "signin", status: "queued" },
      { kind: "signin", status: "queued" },
    ]);
    expect(asks(e)).toBe(2);
    // the row holds no token and no text, the link no hash yet
    const row = app.db
      .query<{ subject: string | null; body: string | null }, [string]>(
        "select subject, body from email_outbox where user_id = ?",
      )
      .all(maria.id);
    expect(row).toEqual([
      { subject: null, body: null },
      { subject: null, body: null },
    ]);
    // the issue is logged by username, never what was typed
    const issued = e.logs.events.filter((ev) => ev.msg === "link issued");
    expect(issued.map((ev) => ev.fields)).toEqual([
      { user: "maria", purpose: "signin" },
      { user: "maria", purpose: "signin" },
    ]);
    expect(JSON.stringify(e.logs.events)).not.toContain("nobody@example.test");
    await app.shutdown();
  });

  test("a browser keeps its challenge, and every ask makes a link that stays live", async () => {
    const e = await emailApp();
    const { app } = e;
    const tab = browser(e);
    const first = await e.ask(tab);
    await app.linkAsks();
    await e.send();
    const [token1, code1] = [e.token(), e.code()];
    const second = await e.ask(tab);
    expect(second.headers.get("set-cookie")!.split(";")[0]).toBe(
      first.headers.get("set-cookie")!.split(";")[0]!,
    );
    await app.linkAsks();
    await e.send();
    const token2 = e.token();
    expect(token2).not.toBe(token1);
    // both links live; the first's code still works beside the cookie
    expect(e.live(token1)).toBe(true);
    expect(e.live(token2)).toBe(true);
    expect((await e.sendCode(tab, code1)).status).toBe(200);
    expect(e.live(token1)).toBe(false);
    expect(e.live(token2)).toBe(true);
    await app.shutdown();
  });

  test("two browsers' asks are both live, each code only beside its own cookie", async () => {
    const e = await emailApp();
    const { app } = e;
    const a = browser(e);
    const b = browser(e);
    await e.ask(a);
    await app.linkAsks();
    await e.send();
    const codeA = e.code();
    await e.ask(b);
    await app.linkAsks();
    await e.send();
    const codeB = e.code();
    // a's code from b is never tried: no try is counted on a's link
    if (codeA !== codeB) {
      expect((await e.sendCode(b, codeA)).status).toBe(401);
      expect(rows(e).map((link) => link.code_tries)).toEqual([0, 1]);
    }
    expect((await e.sendCode(a, codeA)).status).toBe(200);
    expect((await e.sendCode(b, codeB)).status).toBe(200);
    expect(rows(e).every((link) => link.used === 1)).toBe(true);
    await app.shutdown();
  });

  test("a code from a browser that never asked is never tried", async () => {
    const e = await emailApp();
    await e.ask(browser(e));
    await e.app.linkAsks();
    await e.send();
    const res = await e.sendCode(browser(e), e.code());
    expect(res.status).toBe(401);
    expect(rows(e)).toEqual([{ purpose: "signin", code_tries: 0, used: 0 }]);
    await e.app.shutdown();
  });

  test("the fifth wrong try kills the link", async () => {
    const e = await emailApp();
    const tab = browser(e);
    await e.ask(tab);
    await e.app.linkAsks();
    await e.send();
    const [token, code] = [e.token(), e.code()];
    for (let i = 0; i < 4; i++) {
      expect((await e.sendCode(tab, other(code))).status).toBe(401);
    }
    expect(e.live(token)).toBe(true);
    expect((await e.sendCode(tab, other(code))).status).toBe(401);
    expect(rows(e)).toEqual([{ purpose: "signin", code_tries: 5, used: 1 }]);
    expect(e.live(token)).toBe(false);
    expect((await e.sendCode(tab, code)).status).toBe(401);
    await e.app.shutdown();
  });

  test("a miss counts on every link of its challenge, and the fifth kills them all", async () => {
    const e = await emailApp();
    const tab = browser(e);
    const codes: string[] = [];
    for (const client of [tab, tab, browser(e)]) {
      await e.ask(client);
      await e.app.linkAsks();
      await e.send();
      codes.push(e.code());
    }
    let wrong = "000000";
    while (codes.includes(wrong))
      wrong = String(Number(wrong) + 1).padStart(6, "0");
    for (let i = 0; i < 4; i++) {
      expect((await e.sendCode(tab, wrong)).status).toBe(401);
      expect(rows(e).map((link) => link.code_tries)).toEqual([i + 1, i + 1, 0]);
    }
    expect((await e.sendCode(tab, wrong)).status).toBe(401);
    expect(rows(e)).toEqual([
      { purpose: "signin", code_tries: 5, used: 1 },
      { purpose: "signin", code_tries: 5, used: 1 },
      { purpose: "signin", code_tries: 0, used: 0 },
    ]);
    // the other challenge's link is the control: untouched and live
    expect((await e.sendCode(tab, codes[0]!)).status).toBe(401);
    expect((await e.sendCode(tab, codes[1]!)).status).toBe(401);
    expect(e.live(e.token())).toBe(true);
    await e.app.shutdown();
  });

  test("a code sent on the email's last retry still finds its challenge", async () => {
    const e = await emailApp();
    const { app } = e;
    const tab = browser(e);
    await e.ask(tab);
    await app.linkAsks();
    // every try takes the SMTP client's longest; three fail, and the
    // fourth, after the waits between them, is delivered
    const tryMs = Object.values(SMTP_TIMEOUTS).reduce((a, b) => a + b, 0);
    app.emailSender.onSend = () => {
      app.now.value += tryMs;
    };
    app.emailSender.result = "timeout";
    for (const [i, wait] of [0, ...BACKOFF_MS].entries()) {
      app.now.value += wait;
      if (i === BACKOFF_MS.length) app.emailSender.result = "sent";
      expect(await e.send()).toBe(1);
    }
    // late in the code's own 15 minutes, the cookie is still held
    app.now.value += 15 * MINUTE - tryMs - 1;
    expect((await e.sendCode(tab, e.code())).status).toBe(200);
    await app.shutdown();
  });

  test("a renewal is not sent for a login a racing sign-in ended", async () => {
    const e = await emailApp();
    const { app } = e;
    const tab = browser(e);
    expect((await tab.signIn("admin")).status).toBe(200);
    const old = tab.cookie!;
    // the login is due its renewal, and maria asks in this browser
    app.now.value += TOUCH_AFTER_MS + MINUTE;
    const asker = browser(e);
    await e.ask(asker);
    await app.linkAsks();
    await e.send();
    asker.cookie = old;
    // the link's form: resolved (renewal pending) before its body lands
    let release = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => controller.close();
      },
    });
    const link = app.handle(
      new Request(`${ORIGIN}/api/links/${e.token()}`, {
        method: "POST",
        headers: {
          host: "1ctx.test",
          origin: "null",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
          cookie: old,
        },
        body,
      }),
      "10.250.0.1",
    );
    // the code wins, ending the old login
    const code = await e.sendCode(asker, e.code());
    expect(code.status).toBe(200);
    release();
    const lost = (await link)!;
    expect(lost.status).toBe(404);
    expect(
      lost.headers.getSetCookie().filter((c) => c.startsWith("login=")),
    ).toEqual([]);
    await app.shutdown();
  });

  test("a wrong code, another address, no challenge and a bad body are one 401", async () => {
    const e = await emailApp();
    const tab = browser(e);
    await e.ask(tab);
    await e.app.linkAsks();
    await e.send();
    const code = e.code();
    const answers = [
      await e.sendCode(tab, other(code)),
      await e.sendCode(tab, code, "nobody@example.test"),
      await e.sendCode(browser(e), code),
      await tab.call("POST", "/api/login/code", { body: { code } }),
      await tab.call("POST", "/api/login/code", {
        body: { email: "maria@example.test", code: "12345" },
      }),
    ];
    const first = await shown(answers[0]!);
    expect(first.status).toBe(401);
    for (const res of answers.slice(1)) expect(await shown(res)).toEqual(first);
    // and the code still works
    expect((await e.sendCode(tab, code)).status).toBe(200);
    await e.app.shutdown();
  });

  test("a code signs in, ends the browser's login and queues the notice", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    const before = admin.cookie;
    await e.ask(admin);
    await app.linkAsks();
    await e.send();
    const res = await e.sendCode(admin, e.code());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { username: "maria" },
      landing: "/",
    });
    expect(admin.cookie).not.toBe(before);
    expect(
      (await (await admin.call("GET", "/api/me")).json()).user.username,
    ).toBe("maria");
    const old = app.client();
    old.cookie = before;
    expect((await (await old.call("GET", "/api/me")).json()).user).toBeNull();
    expect(app.users.byId(maria.id)!.signedInAt).toBe(app.now.value);
    await e.send();
    expect(app.emailSender.sent.at(-1)!.message.text).toContain(
      "You signed in by email code",
    );
    const used = e.logs.events.find((ev) => ev.msg === "link used");
    expect(used?.fields).toEqual({
      user: "maria",
      purpose: "signin",
      by: "code",
    });
    await app.shutdown();
  });

  test("using the link uses the code, and the code the link", async () => {
    const e = await emailApp();
    const tab = browser(e);
    await e.ask(tab);
    await e.app.linkAsks();
    await e.send();
    const first = { token: e.token(), code: e.code() };
    expect((await e.use(tab, first.token)).status).toBe(303);
    expect((await e.sendCode(tab, first.code)).status).toBe(401);

    await e.ask(tab);
    await e.app.linkAsks();
    await e.send();
    const second = { token: e.token(), code: e.code() };
    expect((await e.sendCode(tab, second.code)).status).toBe(200);
    expect(e.live(second.token)).toBe(false);
    expect((await e.use(tab, second.token)).status).toBe(404);
    await e.app.shutdown();
  });

  test("asks, codes and used links share the login limit", async () => {
    const e = await emailApp();
    const client = e.app.client("10.0.0.9");
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await e.ask(client, `user${i}@example.test`)).status);
    }
    for (let i = 0; i < 2; i++) {
      statuses.push((await e.sendCode(client, "123456")).status);
    }
    for (let i = 0; i < 2; i++) {
      statuses.push((await e.use(client, "A".repeat(43))).status);
    }
    expect(statuses).toEqual([...Array(6).fill(202), 401, 401, 404, 404]);
    expect((await e.ask(client)).status).toBe(429);
    expect((await e.sendCode(client, "123456")).status).toBe(429);
    const login = await client.call("POST", "/api/login", {
      body: { key: ADMIN_KEY },
    });
    expect(login.status).toBe(429);
    await e.app.shutdown();
  });

  test("refuses a bad body with a 400", async () => {
    const e = await emailApp();
    for (const body of [
      {},
      { email: "" },
      { username: "maria" },
      { email: "maria" },
    ]) {
      const res = await browser(e).call("POST", "/api/login/link", { body });
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    await e.app.shutdown();
  });

  test("an ask after the shutdown's wait answers 202 and does nothing", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    expect((await e.ask(browser(e))).status).toBe(202);
    // the shutdown waits for the ask it answered
    await app.shutdown();
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "queued" }]);
    // the listener still serves until the db closes
    expect(await shown(await e.ask(browser(e)))).toEqual(ASKED);
    await app.linkAsks();
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "queued" }]);
  });

  test("is not there while email is off", async () => {
    const e = await emailApp({ email: false });
    expect((await e.ask(browser(e))).status).toBe(404);
    await e.app.linkAsks();
    expect(e.outbox(e.maria.id)).toEqual([]);
    const me = await (await e.app.client().call("GET", "/api/me")).json();
    expect(me.emailOn).toBe(false);
    await e.app.shutdown();
  });
});

describe("the caps on asks", () => {
  // asks and runs the work; the outcome's words, in order
  const askAll = async (
    e: EmailApp,
    asking: { client: TestClient; email?: string }[],
  ) => {
    for (const { client, email } of asking) {
      expect((await e.ask(client, email)).status).toBe(202);
      await e.app.linkAsks();
    }
  };

  test("3 a day per user from one browser, the 4th answers the same", async () => {
    const e = await emailApp();
    const { app } = e;
    const tab = browser(e);
    const start = app.now.value;
    for (let i = 0; i <= ASKS_PER_USER_DAY; i++) {
      expect(await shown(await e.ask(tab))).toEqual(ASKED);
      await app.linkAsks();
      // past the login limit's window
      app.now.value += MINUTE;
    }
    expect(await e.send()).toBe(ASKS_PER_USER_DAY);
    expect(capped(e)).toEqual([{ cap: "user", user: "maria" }]);
    expect(asks(e)).toBe(ASKS_PER_USER_DAY);
    // another browser is not held by it
    await askAll(e, [{ client: browser(e) }]);
    expect(await e.send()).toBe(1);
    // a day after the first, it counts no more
    app.now.value = start + DAY_MS + 1;
    await askAll(e, [{ client: tab }]);
    expect(await e.send()).toBe(1);
    expect(capped(e)).toHaveLength(1);
    await app.shutdown();
  });

  test("10 a day per user across browsers, except from a browser that signed them in", async () => {
    const e = await emailApp();
    const { app } = e;
    // this browser signs maria in by code: it is known from here
    const known = browser(e);
    await askAll(e, [{ client: known }]);
    await e.send();
    expect((await e.sendCode(known, e.code())).status).toBe(200);
    // one killed by wrong codes is not
    const burned = browser(e);
    await askAll(e, [{ client: burned }]);
    await e.send();
    const code = e.code();
    for (let i = 0; i < 5; i++) await e.sendCode(burned, other(code));
    const strangers = Array.from({ length: ASKS_PER_INBOX_DAY - 2 }, () => ({
      client: browser(e),
    }));
    await askAll(e, strangers);
    expect(asks(e)).toBe(ASKS_PER_INBOX_DAY);
    expect(capped(e)).toEqual([]);
    await askAll(e, [{ client: browser(e) }, { client: burned }]);
    expect(capped(e)).toEqual([
      { cap: "inbox", user: "maria" },
      { cap: "inbox", user: "maria" },
    ]);
    // the known browser keeps its own 3
    await askAll(e, [{ client: known }, { client: known }, { client: known }]);
    expect(asks(e)).toBe(ASKS_PER_INBOX_DAY + 2);
    expect(capped(e).at(-1)).toEqual({ cap: "user", user: "maria" });
    await app.shutdown();
  });

  test("5 an hour from one browser, whoever it names", async () => {
    const e = await emailApp();
    const { app } = e;
    const names: string[] = [];
    for (let i = 0; i <= ASKS_PER_CHALLENGE_HOUR; i++) {
      app.createUser({
        username: `user${i}`,
        fullName: `User ${i}`,
        email: `user${i}@example.test`,
        role: "member",
        now: app.now.value,
      });
      names.push(`user${i}@example.test`);
    }
    const tab = browser(e);
    const start = app.now.value;
    // unknown addresses spend nothing
    await askAll(e, [{ client: tab, email: "nobody@example.test" }]);
    for (const email of names) {
      await askAll(e, [{ client: tab, email }]);
      app.now.value += MINUTE;
    }
    expect(asks(e)).toBe(ASKS_PER_CHALLENGE_HOUR);
    expect(capped(e)).toEqual([{ cap: "browser", user: "user5" }]);
    app.now.value = start + HOUR_MS + 1;
    await askAll(e, [{ client: tab, email: names.at(-1)! }]);
    expect(asks(e)).toBe(ASKS_PER_CHALLENGE_HOUR + 1);
    await app.shutdown();
  });

  test("50 an hour per instance, and the Monitor says so from the asks", async () => {
    const e = await emailApp();
    const { app, admin } = e;
    const attention = async () =>
      (
        (await (await admin.call("GET", "/api/admin/attention")).json()) as {
          items: { kind: string }[];
        }
      ).items.map((item) => item.kind);
    const names: string[] = [];
    for (let i = 0; i <= ASKS_PER_HOUR + 1; i++) {
      app.createUser({
        username: `user${i}`,
        fullName: `User ${i}`,
        email: `user${i}@example.test`,
        role: "member",
        now: app.now.value,
      });
      names.push(`user${i}@example.test`);
    }
    const start = app.now.value;
    for (let i = 0; i < ASKS_PER_HOUR - 1; i++) {
      await askAll(e, [{ client: browser(e), email: names[i] }]);
    }
    expect(await attention()).toEqual([]);
    await askAll(e, [{ client: browser(e), email: names[ASKS_PER_HOUR - 1] }]);
    expect(await attention()).toEqual(["links-paused"]);
    expect(app.email.attention()?.linksPaused).toBe(true);
    await askAll(e, [{ client: browser(e), email: names[ASKS_PER_HOUR] }]);
    expect(await e.send()).toBe(ASKS_PER_HOUR);
    expect(capped(e)).toEqual([
      { cap: "instance", user: `user${ASKS_PER_HOUR}` },
    ]);
    // an admin's invite still goes, and is not counted
    expect(
      (await admin.call("POST", `/api/users/${e.maria.id}/invite`)).status,
    ).toBe(204);
    expect(await e.send()).toBe(1);
    expect(asks(e)).toBe(ASKS_PER_HOUR);
    // shown only while email is on
    await admin.call("PUT", "/api/admin/smtp", {
      body: { ...SMTP, keyName: "email-gone" },
    });
    expect(await attention()).toEqual(["smtp-key"]);
    await admin.call("PUT", "/api/admin/smtp", { body: SMTP });
    expect(await attention()).toEqual(["links-paused"]);
    // an hour after the first, they count no more
    app.now.value = start + HOUR_MS + 1;
    expect(await attention()).toEqual([]);
    await askAll(e, [{ client: browser(e), email: names[ASKS_PER_HOUR + 1] }]);
    expect(await e.send()).toBe(1);
    expect(capped(e)).toHaveLength(1);
    await app.shutdown();
  });

  test("records only an admitted ask for an enabled, real address", async () => {
    const e = await emailApp();
    const { app } = e;
    app.createUser({
      username: "gone",
      fullName: "Gone",
      email: "gone@example.test",
      role: "member",
      disabled: true,
      now: app.now.value,
    });
    app.createUser({
      username: "seeded",
      fullName: "Seeded",
      email: "seeded@1ctx.dev",
      role: "member",
      now: app.now.value,
    });
    const tab = browser(e);
    await askAll(
      e,
      ["nobody@example.test", "gone@example.test", "seeded@1ctx.dev"].map(
        (email) => ({ client: tab, email }),
      ),
    );
    expect(asks(e)).toBe(0);
    for (let i = 0; i <= ASKS_PER_USER_DAY; i++) {
      await askAll(e, [{ client: tab }]);
      app.now.value += MINUTE;
    }
    expect(asks(e)).toBe(ASKS_PER_USER_DAY);
    await app.shutdown();
  });

  test("an ask counts a day whatever became of its link, and the sweep keeps that day", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    const tab = browser(e);
    const start = app.now.value;
    for (let i = 0; i < ASKS_PER_USER_DAY; i++) {
      await askAll(e, [{ client: tab }]);
      // a sign out everywhere revokes the queued link and its email
      expect(
        (await admin.call("POST", `/api/users/${maria.id}/sign-out`)).status,
      ).toBe(204);
      app.now.value += MINUTE;
    }
    expect(e.outbox(maria.id)).toEqual([]);
    await askAll(e, [{ client: tab }]);
    expect(capped(e)).toEqual([{ cap: "user", user: "maria" }]);
    // the first ask counts to the end of its day, then goes
    app.now.value = start + DAY_MS - 1;
    app.sweep();
    expect(asks(e)).toBe(ASKS_PER_USER_DAY);
    app.now.value = start + DAY_MS;
    app.sweep();
    expect(asks(e)).toBe(ASKS_PER_USER_DAY - 1);
    app.now.value = start + 2 * DAY_MS;
    app.sweep();
    expect(asks(e)).toBe(0);
    await app.shutdown();
  });
});

describe("a link email", () => {
  test("mints its token and code at the send, and the expiry counts from then", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const tab = browser(e);
    await e.ask(tab);
    await app.linkAsks();
    // queued for most of the link's life before it goes out
    app.now.value += 12 * MINUTE;
    expect(await e.send()).toBe(1);
    expect(e.links(maria.id)).toEqual([
      { purpose: "signin", minted: true, used: false },
    ]);
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.to).toEqual({
      name: "Maria Pop",
      address: "maria@example.test",
    });
    const token = e.token();
    const code = e.code();
    expect(code).toMatch(/^\d{6}$/);
    expect(message.subject).toBe(`Your 1ctx sign-in code: ${code}`);
    expect(message.text).toBe(
      `Sign in to 1ctx: https://1ctx.example.test/link/${token}, or enter ${code}. Both work once, for 15 minutes.\n`,
    );
    expect(message.html).toBeUndefined();
    // the email names neither the user nor anything else of theirs
    expect(message.text).not.toContain("maria");
    app.now.value += 14 * MINUTE;
    expect(e.live(token)).toBe(true);
    app.now.value += MINUTE;
    expect(e.live(token)).toBe(false);
    expect((await e.sendCode(tab, code)).status).toBe(401);
    await app.shutdown();
  });

  test("a retry carries a fresh token and code, a new Message-ID, and the old are dead", async () => {
    const e = await emailApp();
    const { app } = e;
    const tab = browser(e);
    await e.ask(tab);
    await app.linkAsks();
    app.emailSender.result = "timeout";
    await e.send();
    const failed = { token: e.token(), code: e.code() };
    app.emailSender.result = "sent";
    app.now.value += MINUTE;
    await e.send();
    const sent = { token: e.token(), code: e.code() };
    expect(sent.token).not.toBe(failed.token);
    // a client that kept the first copy must not drop this one
    const [first, second] = app.emailSender.sent.map(
      (s) => s.message.messageId,
    );
    expect(second).not.toBe(first);
    expect(e.live(failed.token)).toBe(false);
    expect(e.live(sent.token)).toBe(true);
    if (failed.code !== sent.code) {
      expect((await e.sendCode(tab, failed.code)).status).toBe(401);
    }
    expect((await e.sendCode(tab, sent.code)).status).toBe(200);
    await app.shutdown();
  });

  test("the sender logs no subject, code or token", async () => {
    const e = await emailApp();
    await e.ask(browser(e));
    await e.app.linkAsks();
    await e.send();
    const logged = JSON.stringify(e.logs.events);
    expect(logged).not.toContain(e.code());
    expect(logged).not.toContain(e.token());
    expect(logged).not.toContain("sign-in code");
    await e.app.shutdown();
  });
});

describe("the link page", () => {
  async function sentLink() {
    const e = await emailApp();
    await e.ask(browser(e));
    await e.app.linkAsks();
    await e.send();
    return { ...e, sent: e.token() };
  }

  const snapshot = (e: EmailApp) =>
    JSON.stringify(e.app.db.query("select * from user_links").all());

  test("GET and HEAD change nothing and send no referrer", async () => {
    const e = await sentLink();
    const before = snapshot(e);
    for (let i = 0; i < 2; i++) {
      const res = e.page(e.sent);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("set-cookie")).toBeNull();
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      const html = await res.text();
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
      expect(html).toContain(
        `<form method="post" action="/api/links/${e.sent}">`,
      );
      expect(html).not.toMatch(/<script|<link|@import|url\(/);
      const head = e.page(e.sent, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await head.text()).toBe("");
    }
    expect(snapshot(e)).toBe(before);
    expect(
      e.app.linkPage(
        new Request(`http://1ctx.test/link/${e.sent}`, { method: "POST" }),
      ).status,
    ).toBe(405);
    await e.app.shutdown();
  });

  test("a dead link reads as an unknown one, with a form that asks again", async () => {
    const e = await sentLink();
    const { app } = e;
    const unknown = await shown(e.page("A".repeat(43)));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain("This link no longer works.");
    expect(unknown.body).toContain(
      '<form method="post" action="/api/login/link">',
    );
    expect(await shown(e.page("nope"))).toEqual(unknown);
    // used
    expect((await e.use(browser(e), e.sent)).status).toBe(303);
    expect(await shown(e.page(e.sent))).toEqual(unknown);
    expect(await shown(await e.use(browser(e), e.sent))).toEqual(unknown);
    // expired, never used
    await e.ask(browser(e));
    await app.linkAsks();
    await e.send();
    const expired = e.token();
    app.now.value += 15 * MINUTE;
    expect(await shown(e.page(expired))).toEqual(unknown);
    expect(await shown(await e.use(browser(e), expired))).toEqual(unknown);
    // a disabled user's
    app.now.value += MINUTE;
    await e.ask(browser(e));
    await app.linkAsks();
    await e.send();
    const disabled = e.token();
    await e.admin.call("PATCH", `/api/users/${e.maria.id}`, {
      body: { disabled: true },
    });
    expect(await shown(e.page(disabled))).toEqual(unknown);
    await app.shutdown();
    // with email off, no form
    const off = await emailApp({ email: false });
    const page = await off.page("A".repeat(43)).text();
    expect(page).toContain("This link no longer works.");
    expect(page).not.toContain("<form");
    await off.app.shutdown();
  });

  test("its form, posted as a browser posts it, signs in with a 303", async () => {
    const e = await sentLink();
    const { app, admin, maria } = e;
    const before = admin.cookie;
    const res = await e.use(admin, e.sent);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(admin.cookie).not.toBe(before);
    expect(
      (await (await admin.call("GET", "/api/me")).json()).user.username,
    ).toBe("maria");
    // the browser's admin login ended, it is not kept beside
    const old = app.client();
    old.cookie = before;
    expect((await (await old.call("GET", "/api/me")).json()).user).toBeNull();
    expect(app.users.byId(maria.id)!.signedInAt).toBe(app.now.value);
    await e.send();
    expect(app.emailSender.sent.at(-1)!.message.text).toContain(
      "You signed in by email link",
    );
    // the router logs the route by its pattern, never the token
    expect(JSON.stringify(e.logs.events)).not.toContain(e.sent);
    await app.shutdown();
  });

  test("a post from another site is refused", async () => {
    const e = await sentLink();
    const tries: Parameters<TestClient["call"]>[2][] = [
      { form: {}, origin: "null", headers: { "sec-fetch-site": "cross-site" } },
      { form: {}, origin: "null", headers: { "sec-fetch-site": "same-site" } },
      { form: {}, origin: "null" },
      {
        form: {},
        origin: "https://evil.test",
        headers: { "sec-fetch-site": "cross-site" },
      },
    ];
    for (const opts of tries) {
      const tab = browser(e);
      const res = await tab.call("POST", `/api/links/${e.sent}`, opts);
      expect(res.status).toBe(403);
      expect(tab.cookie).toBeNull();
    }
    // Origin: null passes nowhere else
    const other = await browser(e).call("POST", "/api/login/code", {
      body: { email: "maria@example.test", code: "123456" },
      origin: "null",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(other.status).toBe(403);
    expect(e.live(e.sent)).toBe(true);
    // the app's own origin still works, as a same-origin form
    expect(
      (await browser(e).call("POST", `/api/links/${e.sent}`, { form: {} }))
        .status,
    ).toBe(303);
    await e.app.shutdown();
  });

  test("takes only an empty form", async () => {
    const e = await sentLink();
    const tab = browser(e);
    for (const opts of [{ body: {} }, { form: { password: "x" } }]) {
      const res = await tab.call("POST", `/api/links/${e.sent}`, {
        ...opts,
        origin: "null",
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(res.status).toBe(400);
    }
    expect(e.live(e.sent)).toBe(true);
    await e.app.shutdown();
  });

  test("the dead page's form asks again and answers with a page", async () => {
    const e = await emailApp();
    const tab = browser(e);
    const res = await tab.call("POST", "/api/login/link", {
      form: { email: "maria@example.test" },
      origin: "null",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(
        `^login_ask=[A-Za-z0-9_-]{43}; Path=/api/login; HttpOnly; SameSite=Lax; Max-Age=${ASK_TTL_MS / 1000}$`,
      ),
    );
    const html = await res.text();
    expect(html).toContain("Check your email.");
    // the sign-in opens on the code for the address, from the fragment
    expect(html).toContain(
      '<a href="/#code=maria%40example.test">Enter the code</a>',
    );
    // an unknown address reads the same
    const unknown = await browser(e).call("POST", "/api/login/link", {
      form: { email: "nobody@example.test" },
      origin: "null",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(await unknown.text()).toBe(html.replace("maria%40", "nobody%40"));
    await e.app.linkAsks();
    await e.send();
    // the code works beside that browser's cookie
    expect((await e.sendCode(tab, e.code())).status).toBe(200);
    await e.app.shutdown();
  });

  test("two uses racing: one wins", async () => {
    const e = await sentLink();
    const [a, b] = await Promise.all([
      e.use(browser(e), e.sent),
      e.use(browser(e), e.sent),
    ]);
    expect([a.status, b.status].sort()).toEqual([303, 404]);
    await e.app.shutdown();
  });
});
