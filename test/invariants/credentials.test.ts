// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential is a row an admin writes, its key a file whose name and
// usability the list shows and whose value never leaves. It is bound to
// team projects alone, at most ten to a project and never two whose
// prefixes overlap, and its deletion forgets its switch everywhere.

import { expect, test } from "bun:test";
import type {
  CredentialResponse,
  CredentialsResponse,
} from "../../src/shared/api/credentials.ts";
import { credentialKey } from "../../src/shared/capabilities.ts";
import { MAX_CREDENTIALS_PER_PROJECT } from "../../src/shared/contracts/credential.ts";
import { type TestApp, type TestClient, testApp } from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import { chatApp } from "../helpers/chat.ts";

const KEY = "0123456789abcdef-key";

async function admin(secrets: Record<string, string> = {}) {
  const app = await testApp({
    secrets: {
      "http-quotes": KEY,
      "http-short": "too-short",
      "http-empty": " \n",
      ...secrets,
    },
  });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  return { app, client };
}

async function team(client: TestClient, name: string): Promise<string> {
  const res = await client.call("POST", "/api/projects", {
    body: { name, description: "" },
  });
  expect(res.status).toBe(201);
  return (await res.json()).project.id;
}

const body = (fields: Record<string, unknown> = {}) => ({
  name: "quotes",
  keyName: "http-quotes",
  prefix: "https://quotes.example.test/api/v1/",
  header: "X-Api-Key",
  template: "{key}",
  ...fields,
});

async function create(client: TestClient, fields: Record<string, unknown>) {
  return client.call("POST", "/api/credentials", { body: body(fields) });
}

async function words(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

async function closed(app: TestApp) {
  await app.shutdown();
  app.db.close();
}

test("an admin saves a credential in canonical form and the list never holds a key", async () => {
  const { app, client } = await admin();
  try {
    const finops = await team(client, "finops");
    const res = await create(client, {
      prefix: "https://Quotes.Example.test.:443/api/v1/",
      methods: ["HEAD", "GET"],
      projectIds: [finops],
    });
    expect(res.status).toBe(201);
    const { credential } = (await res.json()) as CredentialResponse;
    expect(credential).toMatchObject({
      name: "quotes",
      keyName: "http-quotes",
      key: "ok",
      prefix: "https://quotes.example.test/api/v1/",
      header: "X-Api-Key",
      template: "{key}",
      methods: ["GET", "HEAD"],
      projects: [{ id: finops, name: "finops" }],
    });
    const list = await client.call("GET", "/api/credentials");
    const text = await list.text();
    expect(text).not.toContain(KEY);
    const answer = JSON.parse(text) as CredentialsResponse;
    expect(answer.keys).toEqual([
      { name: "http-empty", usable: false },
      { name: "http-quotes", usable: true },
      { name: "http-short", usable: false },
    ]);
    expect(answer.credentials).toEqual([credential]);
  } finally {
    await closed(app);
  }
});

test("methods default to GET and HEAD, a key is marked missing or unusable", async () => {
  const { app, client } = await admin();
  try {
    const states: Record<string, string> = {};
    for (const [index, keyName] of [
      "http-quotes",
      "http-short",
      "http-empty",
      "http-absent",
    ].entries()) {
      const res = await create(client, {
        name: `key-${index}`,
        keyName,
        prefix: `https://quotes.example.test/k${index}/`,
      });
      expect(res.status).toBe(201);
      const { credential } = (await res.json()) as CredentialResponse;
      expect(credential.methods).toEqual(["GET", "HEAD"]);
      states[keyName] = credential.key;
    }
    expect(states).toEqual({
      "http-quotes": "ok",
      "http-short": "unusable",
      "http-empty": "unusable",
      "http-absent": "missing",
    });
  } finally {
    await closed(app);
  }
});

test("a request the rules refuse is a 400 that writes nothing", async () => {
  const { app, client } = await admin();
  try {
    const cases: [Record<string, unknown>, string][] = [
      [{ prefix: "http://quotes.example.test/" }, "https"],
      [{ prefix: "https://user:pw@quotes.example.test/" }, "user"],
      [{ prefix: "https://quotes.example.test/?token=1" }, "query"],
      [{ prefix: "https://quotes.example.test/#part" }, "fragment"],
      [
        { prefix: `https://quotes.example.test/${"a".repeat(512)}` },
        "at most 512",
      ],
      [{ header: "Host" }, "cannot carry a key"],
      [{ header: "proxy-authorization" }, "cannot carry a key"],
      [{ header: "TRANSFER-ENCODING" }, "cannot carry a key"],
      [{ header: "X Api Key" }, "header name"],
      [{ template: "Bearer" }, "exactly once"],
      [{ template: "{key}:{key}" }, "exactly once"],
      [{ template: "Bearer {key}\nX: 1" }, "printable ASCII"],
      [{ keyName: "provider-quotes" }, "keyName"],
      [{ name: "Quotes!" }, "name"],
      [{ methods: [] }, "methods"],
      [{ methods: ["GET", "GET"] }, "methods"],
      [{ methods: ["TRACE"] }, "methods"],
      [{ projectIds: ["nope"] }, "no such team project"],
      [{ other: 1 }, "unknown field"],
    ];
    for (const [fields, expected] of cases) {
      const res = await create(client, fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(await words(res)).toContain(expected);
    }
    expect(app.db.query("select * from credentials").all()).toEqual([]);
  } finally {
    await closed(app);
  }
});

test("a personal project cannot be bound, and a name is taken once", async () => {
  const { app, client } = await admin();
  try {
    const personal = app.projects.personal(
      app.users.byUsername("admin")!.id,
    )!.id;
    const res = await create(client, { projectIds: [personal] });
    expect(res.status).toBe(400);
    expect(await words(res)).toBe(`no such team project ${personal}`);
    expect((await create(client, {})).status).toBe(201);
    const again = await create(client, {
      prefix: "https://other.example.test/",
    });
    expect(again.status).toBe(409);
  } finally {
    await closed(app);
  }
});

test("two credentials in one project never overlap, either way round", async () => {
  const { app, client } = await admin();
  try {
    const finops = await team(client, "finops");
    const other = await team(client, "other");
    const narrow = await create(client, {
      name: "narrow",
      prefix: "https://quotes.example.test/api/v1/",
      projectIds: [finops],
    });
    expect(narrow.status).toBe(201);
    // broader than the one held, then narrower than it
    for (const prefix of [
      "https://quotes.example.test/",
      "https://quotes.example.test/api/v1/stocks",
    ]) {
      const res = await create(client, {
        name: "wide",
        prefix,
        projectIds: [finops],
      });
      expect(res.status).toBe(409);
      expect(await words(res)).toBe("the prefix overlaps narrow in finops");
    }
    // the same prefix in another project, then moved into this one
    const wide = await create(client, {
      name: "wide",
      prefix: "https://quotes.example.test/",
      projectIds: [other],
    });
    expect(wide.status).toBe(201);
    const { credential } = (await wide.json()) as CredentialResponse;
    const moved = await client.call(
      "PATCH",
      `/api/credentials/${credential.id}`,
      { body: { projectIds: [other, finops] } },
    );
    expect(moved.status).toBe(409);
    // a prefix change into the other's reach is checked on the same links
    const narrowId = ((await narrow.json()) as CredentialResponse).credential
      .id;
    const both = await client.call("PATCH", `/api/credentials/${narrowId}`, {
      body: { projectIds: [finops, other] },
    });
    expect(both.status).toBe(409);
    expect(await words(both)).toBe("the prefix overlaps wide in other");
    expect(
      (await client.call("GET", "/api/credentials").then((r) => r.json()))
        .credentials,
    ).toMatchObject([
      { name: "narrow", projects: [{ name: "finops" }] },
      { name: "wide", projects: [{ name: "other" }] },
    ]);
    const disjoint = await client.call(
      "PATCH",
      `/api/credentials/${credential.id}`,
      { body: { prefix: "https://quotes.example.test/api/v2/" } },
    );
    expect(disjoint.status).toBe(200);
    const into = await client.call("PATCH", `/api/credentials/${narrowId}`, {
      body: { prefix: "https://quotes.example.test/api/", projectIds: [other] },
    });
    expect(into.status).toBe(409);
    expect(await words(into)).toBe("the prefix overlaps wide in other");
  } finally {
    await closed(app);
  }
});

test("a project holds at most ten credentials", async () => {
  const { app, client } = await admin();
  try {
    const finops = await team(client, "finops");
    for (let i = 0; i < MAX_CREDENTIALS_PER_PROJECT; i++) {
      const res = await create(client, {
        name: `api-${i}`,
        prefix: `https://api${i}.example.test/`,
        projectIds: [finops],
      });
      expect(res.status).toBe(201);
    }
    const eleventh = await create(client, {
      name: "api-10",
      prefix: "https://api10.example.test/",
      projectIds: [finops],
    });
    expect(eleventh.status).toBe(409);
    expect(await words(eleventh)).toBe("finops has 10 credentials");
    // refused whole: nothing of the eleventh is kept
    expect(
      app.db.query("select * from credentials where name = 'api-10'").all(),
    ).toEqual([]);
    // an unbound one saves, and a change to one already bound is no eleventh
    expect(
      (
        await create(client, {
          name: "api-10",
          prefix: "https://api10.example.test/",
        })
      ).status,
    ).toBe(201);
    const held = app.db
      .query<{ id: string }, []>(
        "select id from credentials where name = 'api-0'",
      )
      .get()!;
    const change = await client.call("PATCH", `/api/credentials/${held.id}`, {
      body: { methods: ["GET", "POST"], projectIds: [finops] },
    });
    expect(change.status).toBe(200);
    expect((await change.json()).credential.methods).toEqual(["GET", "POST"]);
  } finally {
    await closed(app);
  }
});

test("a change keeps what it omits and a supplied list replaces", async () => {
  const { app, client } = await admin();
  try {
    const a = await team(client, "alpha");
    const b = await team(client, "beta");
    const res = await create(client, {
      template: "Bearer {key}",
      methods: ["GET", "POST"],
      projectIds: [a],
    });
    const { credential } = (await res.json()) as CredentialResponse;
    const path = `/api/credentials/${credential.id}`;
    const change = await client.call("PATCH", path, {
      body: { header: "Authorization", projectIds: [b] },
    });
    expect(change.status).toBe(200);
    expect((await change.json()).credential).toMatchObject({
      header: "Authorization",
      template: "Bearer {key}",
      methods: ["GET", "POST"],
      prefix: credential.prefix,
      projects: [{ id: b, name: "beta" }],
    });
    for (const patch of [{ name: "renamed" }, { prefix: "http://x.test/" }]) {
      expect((await client.call("PATCH", path, { body: patch })).status).toBe(
        400,
      );
    }
    const missing = await client.call("PATCH", "/api/credentials/nope", {
      body: { header: "X-Key" },
    });
    expect(missing.status).toBe(404);
  } finally {
    await closed(app);
  }
});

test("deleting a project takes its links, the credential stays", async () => {
  const { app, client } = await admin();
  try {
    const finops = await team(client, "finops");
    const res = await create(client, { projectIds: [finops] });
    const { credential } = (await res.json()) as CredentialResponse;
    expect(
      (await client.call("DELETE", `/api/projects/${finops}`)).status,
    ).toBe(200);
    const list = (await (
      await client.call("GET", "/api/credentials")
    ).json()) as CredentialsResponse;
    expect(list.credentials).toMatchObject([
      { id: credential.id, projects: [] },
    ]);
    expect(app.db.query("select * from credential_projects").all()).toEqual([]);
    expect(
      (await client.call("DELETE", `/api/credentials/${credential.id}`)).status,
    ).toBe(204);
    expect(
      (await client.call("DELETE", `/api/credentials/${credential.id}`)).status,
    ).toBe(404);
  } finally {
    await closed(app);
  }
});

test("deleting a credential forgets its key in chats and tasks", async () => {
  const chat = await chatApp({ secrets: { "http-quotes": KEY } });
  chat.app.automationScheduler.stop();
  try {
    const res = await chat.admin.call("POST", "/api/credentials", {
      body: body(),
    });
    const { credential } = (await res.json()) as CredentialResponse;
    const key = credentialKey(credential.id);
    const kept = credentialKey("otherid");
    const sets = [[key, kept, "web"].sort(), [key], ["web"]];
    const chats = sets.map((disabledCapabilities) =>
      chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "Stored chat",
        now: chat.app.now.value,
        status: "done",
        disabledCapabilities,
      }),
    );
    const tasks = await Promise.all(
      sets.map((disabledCapabilities, i) =>
        createAutomation(chat, { name: `task-${i}`, disabledCapabilities }),
      ),
    );
    expect(tasks[0]!.disabledCapabilities).toEqual(sets[0]!);
    const gone = await chat.admin.call(
      "DELETE",
      `/api/credentials/${credential.id}`,
    );
    expect(gone.status).toBe(204);
    const without = (set: string[]) => set.filter((item) => item !== key);
    for (const row of chats) {
      expect(chat.app.sessions.byId(row.id)).toEqual({
        ...row,
        disabledCapabilities: without(row.disabledCapabilities),
      });
    }
    for (const row of tasks) {
      expect(chat.app.automations.byId(row.id)).toEqual({
        ...row,
        disabledCapabilities: without(row.disabledCapabilities),
      });
    }
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});
