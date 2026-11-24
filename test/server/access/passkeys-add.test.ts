// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Adding a passkey from a signed-in browser, listing and removing it,
// through the composed app: the options, every check of the answer, the
// challenge rows, the cap, the login read again inside the write, and
// the email that says one was added. The authenticator is a fake on
// WebCrypto; users, addresses and keys are made up.

import { describe, expect, test } from "bun:test";
import { toB64url } from "../../../src/server/access/passkeys/authenticator.ts";
import {
  CHALLENGE_MS,
  PASSKEYS_PER_USER,
} from "../../../src/server/access/passkeys/store.ts";
import {
  authenticator,
  type Bend,
  loginOf,
  ORIGIN,
  OTHER,
  type PasskeyApp,
  passkeyApp,
} from "../../helpers/passkeys.ts";

type Json = Record<string, unknown>;

const signOut = (t: PasskeyApp, userId: string) =>
  t.admin.call("POST", `/api/users/${userId}/sign-out`);

describe("adding a passkey", () => {
  test("options name the host, the user and the user's passkeys of this host", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const { res, options } = await t.addOptions(maria);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(options).toMatchObject({
      rp: { id: "1ctx.test", name: "1ctx" },
      user: {
        id: toB64url(new TextEncoder().encode(t.maria.id)),
        name: "maria@example.test",
        displayName: "Maria Pop",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: CHALLENGE_MS,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      excludeCredentials: [],
    });
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = await authenticator();
    expect((await t.add(maria, key)).status).toBe(201);
    const elsewhere = await t.login("maria");
    expect(
      (await t.add(elsewhere, await authenticator(), {}, OTHER)).status,
    ).toBe(201);
    expect((await t.addOptions(maria)).options.excludeCredentials).toEqual([
      { type: "public-key", id: key.id, transports: ["hybrid", "internal"] },
    ]);
    // a placeholder address is named by the username
    const admin = await t.login("admin");
    expect((await t.addOptions(admin)).options.user.name).toBe("admin");
  });

  test("an ES256 and an RS256 passkey are added, listed and sign in", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    for (const kind of ["ES256", "RS256"] as const) {
      const key = await authenticator(kind);
      const added = await t.add(maria, key);
      expect(added.status).toBe(201);
      const item = (await added.json()) as Json;
      expect(item).toEqual({
        id: expect.stringMatching(/^[a-z0-9]{12}$/),
        credentialId: key.id,
        origin: ORIGIN,
        device: "Passkey",
        createdAt: t.app.now.value,
        lastUsedAt: null,
      });
      t.app.now.value += 1000;
      const res = await t.signIn(key);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        user: expect.objectContaining({ username: "maria" }),
        landing: "/",
      });
      expect(await t.me(loginOf(res))).toBe("maria");
      const listed = await t.list(maria);
      expect(listed.find((p) => p.id === item.id)?.lastUsedAt).toBe(
        t.app.now.value,
      );
    }
    expect(await t.list(maria)).toHaveLength(2);
    // the challenges were used, so none is left
    expect(t.count("passkey_challenges")).toBe(0);
  });

  test("an answer that fails a check adds nothing", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const other = await authenticator();
    const cases: [string, Bend][] = [
      ["a wrong origin", { client: { origin: OTHER } }],
      ["a sign-in's type", { client: { type: "webauthn.get" } }],
      ["a cross-origin frame", { client: { crossOrigin: true } }],
      ["another relying party", { rpId: "other.test" }],
      ["no user verification", { flags: 0x41 }],
      ["no user presence", { flags: 0x44 }],
      ["no attested data", { flags: 0x05 }],
      ["backed up, not backup eligible", { flags: 0x55 }],
      ["a credential id that is not rawId", { attestedId: other.rawId }],
      ["a key of another algorithm", { alg: -257 }],
      ["an algorithm not offered", { alg: -8 }],
      ["an unknown challenge", { client: { challenge: "A".repeat(43) } }],
    ];
    for (const [name, bend] of cases) {
      const res = await t.add(maria, await authenticator(), bend);
      expect([name, res.status]).toEqual([name, 400]);
    }
    for (const kind of ["P384", "RS1024"] as const) {
      const res = await t.add(maria, await authenticator(kind), {
        alg: kind === "P384" ? -7 : -257,
      });
      expect([kind, res.status]).toEqual([kind, 400]);
    }
    // an RSA key named ES256
    const rsa = await authenticator("RS256");
    expect((await t.add(maria, rsa, { alg: -7 })).status).toBe(400);
    // a body that is no answer, and a form
    expect((await t.postAdd(maria, { type: "public-key" })).status).toBe(400);
    const form = await t.call(ORIGIN, "POST", "/api/profile/passkeys", {
      cookie: maria,
      body: "type=public-key",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(400);
    expect(t.count("passkeys")).toBe(0);
  });

  test("the challenge is used once, held to its login and origin, and lives two minutes", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const maria2 = await t.login("maria");
    const key = await authenticator();
    const { options } = await t.addOptions(maria);
    const body = await key.create(options, ORIGIN);
    // another login of the same user cannot answer it
    expect((await t.postAdd(maria2, body)).status).toBe(400);
    expect((await t.postAdd(maria, body)).status).toBe(201);
    // replayed
    expect((await t.postAdd(maria, body)).status).toBe(400);
    // another host's challenge, answered here
    const there = (await t.addOptions(maria, OTHER)).options;
    const crossed = await (await authenticator()).create(there, ORIGIN, {
      rpId: "1ctx.test",
    });
    expect((await t.postAdd(maria, crossed)).status).toBe(400);
    // a sign-in's challenge answered as an add
    const signIn = await t.signInOptions();
    const purpose = await (await authenticator()).create(
      {
        challenge: signIn.challenge,
        rp: { id: "1ctx.test" },
        user: { id: "" },
      },
      ORIGIN,
    );
    expect((await t.postAdd(maria, purpose)).status).toBe(400);
    // expired
    const late = (await t.addOptions(maria)).options;
    t.app.now.value += CHALLENGE_MS;
    const answer = await (await authenticator()).create(late, ORIGIN);
    expect((await t.postAdd(maria, answer)).status).toBe(400);
    // each insert deletes the expired rows
    expect(t.count("passkey_challenges")).toBe(3);
    await t.addOptions(maria);
    expect(t.count("passkey_challenges")).toBe(1);
  });

  test(`at most ${PASSKEYS_PER_USER} a user across hosts, then 409`, async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    for (let i = 0; i < PASSKEYS_PER_USER - 1; i++) {
      const origin = i % 2 === 0 ? ORIGIN : OTHER;
      expect(
        (await t.add(maria, await authenticator(), {}, origin)).status,
      ).toBe(201);
    }
    // two options while one place is left; the second answer finds it taken
    const first = (await t.addOptions(maria)).options;
    const second = (await t.addOptions(maria)).options;
    const a = await (await authenticator()).create(first, ORIGIN);
    const b = await (await authenticator()).create(second, ORIGIN);
    expect((await t.postAdd(maria, a)).status).toBe(201);
    const eleventh = await t.postAdd(maria, b);
    expect(eleventh.status).toBe(409);
    expect(await eleventh.json()).toEqual({
      error: `at most ${PASSKEYS_PER_USER} passkeys a user`,
    });
    expect((await t.addOptions(maria)).res.status).toBe(409);
    expect(t.count("passkeys")).toBe(PASSKEYS_PER_USER);
  });

  test("an answer whose id is not its rawId, or whose attested id is empty or too long, adds nothing", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const answer = async (
      edit: (body: Json) => void,
      bend: Bend = {},
    ): Promise<Response> => {
      const { options } = await t.addOptions(maria);
      const body = await (await authenticator()).create(options, ORIGIN, bend);
      edit(body);
      return t.postAdd(maria, body);
    };
    const other = await authenticator();
    expect((await answer((b) => (b.id = other.id))).status).toBe(400);
    expect(
      (await answer(() => {}, { attestedId: new Uint8Array(0) })).status,
    ).toBe(400);
    const long = new Uint8Array(1024).fill(3);
    const tooLong = await answer(
      (b) => {
        b.id = toB64url(long);
        b.rawId = toB64url(long);
      },
      { attestedId: long },
    );
    expect(tooLong.status).toBe(400);
    expect(t.count("passkeys")).toBe(0);
  });

  test("another user's credential is never added twice", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const admin = await t.login("admin");
    const key = await authenticator();
    expect((await t.add(maria, key)).status).toBe(201);
    expect((await t.add(admin, key)).status).toBe(409);
    expect(t.count("passkeys where user_id = ?", t.maria.id)).toBe(1);
    expect(t.count("passkeys")).toBe(1);
  });

  test("a sign out everywhere between the options and the answer adds nothing", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const { options } = await t.addOptions(maria);
    const body = await (await authenticator()).create(options, ORIGIN);
    expect((await signOut(t, t.maria.id)).status).toBe(204);
    expect((await t.postAdd(maria, body)).status).toBe(401);
    // and one landing mid-call: the login was read, the body still coming
    const again = await t.login("maria");
    const late = (await t.addOptions(again)).options;
    const text = JSON.stringify(
      await (await authenticator()).create(late, ORIGIN),
    );
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        reading.resolve();
        await release.promise;
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const pending = t.app.handle(
      new Request(`${ORIGIN}/api/profile/passkeys`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: again,
          "content-type": "application/json",
        },
        body: stream,
      }),
      "10.1.1.1",
    ) as Promise<Response>;
    await reading.promise;
    expect((await signOut(t, t.maria.id)).status).toBe(204);
    release.resolve();
    expect((await pending).status).toBe(401);
    expect(t.count("passkeys")).toBe(0);
    // the add's challenges went with the logins that asked
    expect(t.count("passkey_challenges")).toBe(0);
  });

  test("an add emails the user's address with the server's, never a sign-in link; none to a placeholder or with email off", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const apple = Uint8Array.from(
      Buffer.from("fbfc3007154e4ecc8c0b6e020557d7bd", "hex"),
    );
    const added = await t.add(maria, await authenticator(), { aaguid: apple });
    expect(added.status).toBe(201);
    expect(((await added.json()) as Json).device).toBe("Apple Passwords");
    // the admin's address is a placeholder
    const admin = await t.login("admin");
    expect((await t.add(admin, await authenticator())).status).toBe(201);
    expect(await t.send()).toBe(1);
    const sent = t.app.emailSender.sent;
    expect(sent).toHaveLength(1);
    const { message } = sent[0]!;
    expect(message.to.address).toBe("maria@example.test");
    expect(message.subject).toBe("A passkey was added to your 1ctx sign-in");
    // the time in maria's zone, Europe/Bucharest
    expect(message.text).toBe(
      "A passkey in Apple Passwords was added to your 1ctx sign-in, 1 Jan 1970 at 02:16 (Europe/Bucharest). Not you? Sign in at https://1ctx.example.test/, remove it under Passkeys on your profile, and have an admin sign you out everywhere.\n",
    );
    expect(message.text).not.toContain("/link/");
    const off = await passkeyApp({ email: false });
    const offMaria = await off.login("maria");
    expect((await off.add(offMaria, await authenticator())).status).toBe(201);
    expect(await off.send()).toBe(0);
    expect(off.count("email_outbox")).toBe(0);
  });

  test("an add from an unknown provider emails without naming one", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    expect((await t.add(maria, await authenticator())).status).toBe(201);
    expect(await t.send()).toBe(1);
    expect(t.app.emailSender.sent[0]!.message.text).toStartWith(
      "A passkey was added to your 1ctx sign-in, ",
    );
  });

  test("a user removes their own passkey, never another's", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const admin = await t.login("admin");
    const item = (await (await t.add(maria, await authenticator())).json()) as {
      id: string;
    };
    const remove = (cookie: string, id: string, origin?: string) =>
      t.call(ORIGIN, "DELETE", `/api/profile/passkeys/${id}`, {
        cookie,
        origin,
      });
    expect((await remove(admin, item.id)).status).toBe(404);
    expect((await remove(maria, item.id, "https://evil.test")).status).toBe(
      403,
    );
    expect((await remove(maria, "not-an-id!")).status).toBe(404);
    expect((await remove(maria, item.id)).status).toBe(204);
    expect(await t.list(maria)).toEqual([]);
    expect((await remove(maria, item.id)).status).toBe(404);
    expect(
      t.logs.events.find((e) => e.msg === "passkey removed")?.fields,
    ).toEqual({ user: "maria", passkey: item.id });
  });

  test("a removal from a login that ended removes nothing", async () => {
    const t = await passkeyApp();
    const maria = await t.login("maria");
    const row = (await (await t.add(maria, await authenticator())).json()) as {
      id: string;
    };
    t.app.db.query("delete from logins where user_id = ?").run(t.maria.id);
    const res = await t.call(
      ORIGIN,
      "DELETE",
      `/api/profile/passkeys/${row.id}`,
      { cookie: maria },
    );
    expect(res.status).toBe(401);
    expect(t.count("passkeys")).toBe(1);
  });
});
