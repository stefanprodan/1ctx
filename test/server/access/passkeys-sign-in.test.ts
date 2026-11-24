// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Signing in with a passkey through the composed app: every check of the
// answer is the one 401 but an unknown passkey's, the challenge rows,
// the origin a passkey is held to, the limits, the logs, and the trust
// of the login that added it (an admin key's file, a rename, a demote,
// a disable, sign out everywhere). The authenticator is a fake on
// WebCrypto; users, addresses and keys are made up.

import { describe, expect, test } from "bun:test";
import type { Bytes } from "../../../src/server/access/passkeys/authenticator.ts";
import { toB64url } from "../../../src/server/access/passkeys/authenticator.ts";
import { CHALLENGE_MS } from "../../../src/server/access/passkeys/store.ts";
import {
  LOGIN_LIMIT,
  OPTIONS_LIMIT,
} from "../../../src/server/access/routes.ts";
import { MINUTE_MS } from "../../../src/server/lib/clock.ts";
import { ADMIN_KEY } from "../../helpers/app.ts";
import {
  authenticator,
  loginOf,
  ORIGIN,
  OTHER,
  type PasskeyApp,
  passkeyApp,
} from "../../helpers/passkeys.ts";

const key = (c: string) => `1ctx-admin-${c.repeat(43)}`;

// a login by admin key, as its cookie pair
async function keyLogin(t: PasskeyApp, value: string): Promise<string> {
  const res = await t.call(ORIGIN, "POST", "/api/login", {
    body: { key: value },
  });
  expect(res.status).toBe(200);
  return loginOf(res);
}

describe("signing in with a passkey", () => {
  test("every failed sign-in answers the same 401, an unknown passkey's with its code", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator("ES256", 5);
    expect((await t.add(maria, k)).status).toBe(201);
    const unknown = await authenticator();
    const cases: [string, () => Promise<Response>][] = [
      ["a wrong origin", () => t.signIn(k, { client: { origin: OTHER } })],
      [
        "an add's type",
        () => t.signIn(k, { client: { type: "webauthn.create" } }),
      ],
      [
        "a cross-origin frame",
        () => t.signIn(k, { client: { crossOrigin: true } }),
      ],
      ["another relying party", () => t.signIn(k, { rpId: "other.test" })],
      ["no user verification", () => t.signIn(k, { flags: 0x01 })],
      [
        "attested data",
        () =>
          t.signIn(k, {
            flags: 0x45,
            tail: new Uint8Array([...new Uint8Array(16), 0, 2, 1, 2, 0xa5]),
          }),
      ],
      ["backed up, not backup eligible", () => t.signIn(k, { flags: 0x15 })],
      [
        "bytes after the head with no flag for them",
        () => t.signIn(k, { tail: new Uint8Array([0xa0]) }),
      ],
      ["a bad signature", () => t.signIn(k, { spoil: true })],
      [
        "another user's handle",
        () =>
          t.signIn(k, {
            userHandle: new TextEncoder().encode(
              t.app.users.byUsername("admin")!.id,
            ) as Bytes,
          }),
      ],
      ["no user handle", () => t.signIn(k, { userHandle: null })],
      ["a count going to 0", () => t.signIn(k, { count: 0 })],
      ["a count standing still", () => t.signIn(k, { count: 5 })],
      [
        "an unknown challenge",
        () => t.signIn(k, { client: { challenge: "A".repeat(43) } }),
      ],
      ["a body that is not an answer", () => t.answer({ id: k.id })],
      ["no body", () => t.answer("not json")],
    ];
    const answers: unknown[] = [];
    for (const [name, attempt] of cases) {
      const res = await attempt();
      expect([name, res.status]).toEqual([name, 401]);
      expect(res.headers.get("set-cookie")).toBeNull();
      answers.push(await res.json());
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ error: "passkey not accepted" });
    // the page asks the browser to forget a passkey this server never held
    const gone = await t.signIn(unknown);
    expect(gone.status).toBe(401);
    expect(gone.headers.get("set-cookie")).toBeNull();
    expect(await gone.json()).toEqual({
      error: "passkey not accepted",
      code: "unknown_passkey",
    });
    // the count moves forward, and back is refused
    expect((await t.signIn(k)).status).toBe(200);
    // backed up and eligible, and extension data after its flag
    expect((await t.signIn(k, { flags: 0x1d })).status).toBe(200);
    expect(
      (await t.signIn(k, { flags: 0x85, tail: new Uint8Array([0xa0]) })).status,
    ).toBe(200);
    expect((await t.signIn(k, { count: k.count - 1 })).status).toBe(401);
    expect((await t.signIn(k)).status).toBe(200);
    // only maria's login and the four the passkey opened
    expect(t.count("logins where user_id = ?", t.maria.id)).toBe(5);
  });

  test("a challenge is used once, of its purpose and origin, and lives two minutes", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator();
    expect((await t.add(maria, k)).status).toBe(201);
    const body = await k.get(await t.signInOptions(), ORIGIN);
    expect((await t.answer(body)).status).toBe(200);
    expect((await t.answer(body)).status).toBe(401);
    // an add's challenge answered as a sign-in
    const add = (await t.addOptions(maria)).options;
    const crossed = await k.get(
      { challenge: add.challenge, rpId: "1ctx.test" },
      ORIGIN,
    );
    expect((await t.answer(crossed)).status).toBe(401);
    // another host's challenge
    const there = await t.signInOptions(OTHER);
    const moved = await k.get(
      { challenge: there.challenge, rpId: "1ctx.test" },
      ORIGIN,
    );
    expect((await t.answer(moved)).status).toBe(401);
    const late = await t.signInOptions();
    t.app.now.value += CHALLENGE_MS;
    expect((await t.answer(await k.get(late, ORIGIN))).status).toBe(401);
  });

  test("a sign-in whose id is not its rawId, or posted as a form, opens no login", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator();
    expect((await t.add(maria, k)).status).toBe(201);
    const body = await k.get(await t.signInOptions(), ORIGIN);
    const res = await t.answer({ ...body, rawId: (await authenticator()).id });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "passkey not accepted" });
    const form = await t.call(ORIGIN, "POST", "/api/login/passkey", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(401);
    expect(form.headers.get("set-cookie")).toBeNull();
    expect(t.count("logins where user_id = ?", t.maria.id)).toBe(1);
  });

  test("a passkey signs in only at the origin it was added at, port included", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator();
    expect((await t.add(maria, k)).status).toBe(201);
    const there = await t.signIn(k, {}, OTHER);
    expect(there.status).toBe(401);
    // held here, so the browser is never asked to forget it
    expect(await there.json()).toEqual({ error: "passkey not accepted" });
    const unknown = await t.signIn(await authenticator(), {}, OTHER);
    expect(await unknown.json()).toMatchObject({ code: "unknown_passkey" });
    expect((await t.signIn(k)).status).toBe(200);

    const added = "http://localhost:1236";
    const other = "http://localhost:3000";
    const local = await authenticator();
    expect((await t.add(maria, local, {}, added)).status).toBe(201);
    expect(
      t.app.db
        .query("select rp_id, origin from passkeys where credential_id = ?")
        .get(local.id),
    ).toEqual({ rp_id: "localhost", origin: added });
    // the same rp id from another port's page
    expect((await t.signIn(local, {}, other)).status).toBe(401);
    // a challenge of the other port, answered from this port's page
    const crossed = await local.get(await t.signInOptions(other), added);
    expect((await t.answer(crossed, null, added)).status).toBe(401);
    expect((await t.signIn(local, {}, added)).status).toBe(200);
    // an add's challenge is held to its port too
    const { options } = await t.addOptions(maria, other);
    const body = await (await authenticator()).create(options, added);
    expect((await t.postAdd(maria, body, added)).status).toBe(400);
    // the keychain keys by host, so another port's add leaves it out too
    const exclude = (await t.addOptions(maria, other)).options
      .excludeCredentials as unknown[];
    expect(exclude).toHaveLength(1);
  });

  test("a sign-in ends the browser's older login and publishes nothing else", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const admin = await t.login("admin");
    const k = await authenticator();
    expect((await t.add(maria, k)).status).toBe(201);
    const res = await t.signIn(k, {}, ORIGIN, admin);
    expect(res.status).toBe(200);
    expect(await t.me(admin)).toBeNull();
    expect(await t.me(loginOf(res))).toBe("maria");
    expect(t.logs.events.find((e) => e.msg === "passkey used")?.fields).toEqual(
      { user: "maria", passkey: expect.stringMatching(/^[a-z0-9]{12}$/) },
    );
  });
});

describe("the routes", () => {
  test("a ceremony needs an https Origin or loopback, else 403", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const routes: [string, string | null][] = [
      ["/api/profile/passkeys/options", maria],
      ["/api/profile/passkeys", maria],
      ["/api/login/passkey/options", null],
      ["/api/login/passkey", null],
    ];
    for (const [path, cookie] of routes) {
      for (const [at, origin] of [
        [ORIGIN, null],
        ["http://192.168.1.20:1236", "http://192.168.1.20:1236"],
        ["http://1ctx.test", "http://1ctx.test"],
        [ORIGIN, "null"],
        [ORIGIN, `${ORIGIN}/path`],
        [ORIGIN, "https://evil.test"],
      ] as const) {
        const res = await t.call(at, "POST", path, {
          cookie,
          body: {},
          origin,
        });
        expect([path, origin, res.status]).toEqual([path, origin, 403]);
      }
    }
    expect(t.count("passkey_challenges")).toBe(0);
  });

  test("the answers share the login limit of an address with the codes, the options have their own", async () => {
    const t = await passkeyApp();
    const address = "192.0.2.7";
    const code = () =>
      t.call(ORIGIN, "POST", "/api/login/code", {
        body: { email: "maria@example.test", code: "000000" },
        address,
      });
    const options = () =>
      t.call(ORIGIN, "POST", "/api/login/passkey/options", { address });
    const answer = () =>
      t.call(ORIGIN, "POST", "/api/login/passkey", {
        body: { type: "public-key" },
        address,
      });
    // a sign-in page reloaded often never spends the sign-in's window
    for (let i = 0; i < OPTIONS_LIMIT; i++) {
      expect((await options()).status).toBe(200);
    }
    const throttled = await options();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    for (let i = 0; i < LOGIN_LIMIT / 2; i++) {
      expect((await code()).status).toBe(401);
      expect((await answer()).status).toBe(401);
    }
    t.app.now.value += 15_000;
    const over = await answer();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("45");
    expect((await code()).status).toBe(429);
    t.app.now.value += MINUTE_MS;
    expect((await options()).status).toBe(200);
    expect((await code()).status).toBe(401);
  });

  test("no log line holds a credential id, a key or a challenge", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator();
    const { options } = await t.addOptions(maria);
    const body = await k.create(options, ORIGIN);
    expect((await t.postAdd(maria, body)).status).toBe(201);
    const signInOptions = await t.signInOptions();
    const login = await t.answer(await k.get(signInOptions, ORIGIN));
    expect(login.status).toBe(200);
    expect((await t.signIn(k, { spoil: true })).status).toBe(401);
    const spki = toB64url(await k.spki());
    const text = JSON.stringify(t.logs.events);
    expect(text).toContain("passkey added");
    expect(text).toContain("passkey used");
    expect(
      t.logs.events.find((e) => e.msg === "passkey refused")?.fields,
    ).toMatchObject({ reason: "signature" });
    for (const secret of [
      k.id,
      spki,
      options.challenge,
      signInOptions.challenge,
      loginOf(login).slice("login=".length),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("the trust of the login that added it", () => {
  test("a passkey added from a key login keeps its digest, and so does the login it opens", async () => {
    const secrets = { "user-admin": ADMIN_KEY };
    const t = await passkeyApp({ secrets });
    const admin = await keyLogin(t, ADMIN_KEY);
    const maria = await t.login("maria");
    const adminKey = await authenticator();
    const mariaKey = await authenticator();
    expect((await t.add(admin, adminKey)).status).toBe(201);
    expect((await t.add(maria, mariaKey)).status).toBe(201);
    const digests = t.app.db
      .query<{ username: string; key: number }, []>(
        `select u.username, p.key_digest is not null as key from passkeys p
         join users u on u.id = p.user_id order by u.username`,
      )
      .all();
    expect(digests).toEqual([
      { username: "admin", key: 1 },
      { username: "maria", key: 0 },
    ]);
    const opened = await t.signIn(adminKey);
    expect(opened.status).toBe(200);
    const adminId = t.app.users.byUsername("admin")!.id;
    expect(
      t.app.db
        .query<{ same: number }, [string, string]>(
          `select (select key_digest from logins where user_id = ?1
              order by rowid desc limit 1)
            = (select key_digest from passkeys where user_id = ?2) as same`,
        )
        .get(adminId, adminId),
    ).toEqual({ same: 1 });
    const byEmail = await t.signIn(mariaKey);
    expect(byEmail.status).toBe(200);
    expect(
      t.count("logins where user_id = ? and key_digest is null", t.maria.id),
    ).toBe(2);
    // the key file changes: the passkey signs nobody in, and its login ends
    secrets["user-admin"] = key("n");
    expect((await t.signIn(adminKey)).status).toBe(401);
    expect(await t.me(loginOf(opened))).toBeNull();
    // the refused sign-in took the passkey; maria's stays
    expect(t.count("passkeys")).toBe(1);
    expect(t.count("passkeys where user_id = ?", t.maria.id)).toBe(1);
    // one never tried is taken by the minute's check, with the first
    // key login, never used since its key changed, and the new one
    const again = await keyLogin(t, key("n"));
    expect((await t.add(again, await authenticator())).status).toBe(201);
    secrets["user-admin"] = key("m");
    const start = t.app.now.value;
    const next = t.app.slept((at) => at > start + MINUTE_MS);
    t.app.now.value = start + MINUTE_MS;
    await next;
    expect(t.count("passkeys")).toBe(1);
    expect(
      t.logs.events.findLast((e) => e.msg === "key logins ended")?.fields,
    ).toEqual({ logins: 2, passkeys: 1 });
  });

  test("a removed or changed key file, a rename or a demote ends a key passkey for good; a disable deletes every passkey", async () => {
    const secrets: Record<string, string> = {
      "user-admin": ADMIN_KEY,
      "user-ops": key("o"),
    };
    const t = await passkeyApp({ secrets });
    const ops = t.app.createUser({
      username: "ops",
      fullName: "Ops",
      email: "ops@example.test",
      role: "admin",
      now: t.app.now.value,
    });
    const add = async () => {
      const k = await authenticator();
      const login = await keyLogin(t, secrets["user-ops"]!);
      expect((await t.add(login, k)).status).toBe(201);
      return k;
    };
    const patch = (body: unknown) =>
      t.admin.call("PATCH", `/api/users/${ops.id}`, { body });
    const held = () => t.count("passkeys where user_id = ?", ops.id);
    // a removed file: refused, and the passkey goes, so the file put
    // back never revives it
    let k = await add();
    delete secrets["user-ops"];
    const removed = await t.signIn(k);
    expect(removed.status).toBe(401);
    expect(await removed.json()).toEqual({ error: "passkey not accepted" });
    expect(held()).toBe(0);
    secrets["user-ops"] = key("o");
    expect((await t.signIn(k)).status).toBe(401);
    // a changed file, then the old one back
    k = await add();
    secrets["user-ops"] = key("p");
    expect((await t.signIn(k)).status).toBe(401);
    expect(held()).toBe(0);
    secrets["user-ops"] = key("o");
    expect((await t.signIn(k)).status).toBe(401);
    // renamed: the rename's write ends it, so renaming back with the
    // same file keeps it dead
    k = await add();
    expect((await patch({ username: "ops2" })).status).toBe(200);
    expect(held()).toBe(0);
    expect((await patch({ username: "ops" })).status).toBe(200);
    expect((await t.signIn(k)).status).toBe(401);
    // demoted, then promoted again before any sweep: still dead
    k = await add();
    expect((await patch({ role: "member" })).status).toBe(200);
    expect(held()).toBe(0);
    expect((await patch({ role: "admin" })).status).toBe(200);
    expect((await t.signIn(k)).status).toBe(401);
    // a passkey added by email survives a rename and a demote
    const byEmail = await authenticator();
    expect((await t.add(await t.login("ops"), byEmail)).status).toBe(201);
    expect((await patch({ username: "ops3" })).status).toBe(200);
    expect((await patch({ role: "member" })).status).toBe(200);
    expect((await t.signIn(byEmail)).status).toBe(200);
    expect((await patch({ role: "admin" })).status).toBe(200);
    expect((await patch({ username: "ops" })).status).toBe(200);
    // disabled: every passkey of the user goes
    k = await add();
    expect(held()).toBe(2);
    expect((await patch({ disabled: true })).status).toBe(200);
    expect(held()).toBe(0);
    expect((await t.signIn(k)).status).toBe(401);
  });

  test("sign out everywhere removes the user's passkeys", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const k = await authenticator();
    expect((await t.add(maria, k)).status).toBe(201);
    expect(
      (await t.admin.call("POST", `/api/users/${t.maria.id}/sign-out`)).status,
    ).toBe(204);
    expect(t.count("passkeys")).toBe(0);
    const res = await t.signIn(k);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unknown_passkey" });
  });

  test("the sweep deletes expired challenges", async () => {
    const t = await passkeyApp();
    await t.signInOptions();
    const maria = await t.login("maria");
    await t.addOptions(maria);
    expect(t.count("passkey_challenges")).toBe(2);
    t.app.now.value += CHALLENGE_MS;
    t.app.sweep();
    expect(t.count("passkey_challenges")).toBe(0);
  });
});
