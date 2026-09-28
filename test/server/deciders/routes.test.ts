// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deciders API: a model from the decisions catalog, one default
// handed on as agents' is, a provider held while a decider uses it, and
// Check answered or a 502 in the wire's words. The decisions API: the
// code's settings until an admin saves their own.

import { describe, expect, test } from "bun:test";
import type { DecisionUsageResponse } from "../../../src/shared/api/deciders.ts";
import type {
  DecisionResponse,
  DecisionsResponse,
  SaveDecisionRequest,
} from "../../../src/shared/api/decisions.ts";
import type { DeciderSummary } from "../../../src/shared/contracts/decider.ts";
import {
  DECISION_OPTIONS,
  type DecisionSummary,
  MAX_OPTION_TEXT,
} from "../../../src/shared/contracts/decision.ts";
import {
  collectLogs,
  GEMINI_URL,
  KEV_URL,
  PROVIDER_URL,
  testApp,
} from "../../helpers/app.ts";

async function admin() {
  const logs = collectLogs();
  const app = await testApp({
    secrets: { "provider-router": "sk-router" },
    logFactory: logs.logFactory,
  });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  const provider = async (name: string, wire: string, baseUrl: string) => {
    const res = await client.call("POST", "/api/providers", {
      body: {
        name,
        wire,
        baseUrl,
        keyName: name === "router" ? "provider-router" : null,
      },
    });
    return ((await res.json()) as { provider: { id: string } }).provider.id;
  };
  const router = await provider("router", "openrouter", PROVIDER_URL);
  const kev = await provider("kev-serve", "openai-compatible", KEV_URL);
  const gemini = await provider("gemini", "gemini", GEMINI_URL);
  const save = async (body: unknown, id?: string) =>
    client.call(id ? "PATCH" : "POST", `/api/deciders${id ? `/${id}` : ""}`, {
      body,
    });
  const created = async (body: unknown): Promise<DeciderSummary> =>
    ((await (await save(body)).json()) as { decider: DeciderSummary }).decider;
  const list = async (): Promise<DeciderSummary[]> =>
    (
      (await (await client.call("GET", "/api/deciders")).json()) as {
        deciders: DeciderSummary[];
      }
    ).deciders;
  return { app, client, logs, router, kev, gemini, save, created, list };
}

type Admin = Awaited<ReturnType<typeof admin>>;

const defaults = (rows: DeciderSummary[]) =>
  rows.filter((row) => row.default).map((row) => row.name);

describe("deciders", () => {
  test("keeps what the decisions catalog said and makes the first the default", async () => {
    const { created, router, kev, list, logs } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    expect(jev).toMatchObject({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
      contextLength: 32000,
      promptPrice: expect.any(Number),
      default: true,
    });
    const local = await created({
      name: "kev",
      providerId: kev,
      model: "kev-latest",
    });
    expect(local).toMatchObject({
      contextLength: null,
      promptPrice: null,
      default: false,
    });
    expect((await list()).map((row) => row.name)).toEqual(["jev", "kev"]);
    expect(
      logs.events.filter((event) => event.msg === "decider created"),
    ).toEqual([
      {
        level: "info",
        area: "deciders",
        msg: "decider created",
        fields: { name: "jev", provider: "router", model: "typesafe/jev-1.13" },
      },
      {
        level: "info",
        area: "deciders",
        msg: "decider created",
        fields: { name: "kev", provider: "kev-serve", model: "kev-latest" },
      },
    ]);
  });

  test("hands the default on as the mark moves and the default goes", async () => {
    const { client, created, save, router, kev, list, logs } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    const local = await created({
      name: "kev",
      providerId: kev,
      model: "kev-latest",
      default: true,
    });
    expect(defaults(await list())).toEqual(["kev"]);
    // a save that leaves the field out leaves the mark
    await save({ name: "kev", providerId: kev, model: "kev-latest" }, local.id);
    expect(defaults(await list())).toEqual(["kev"]);
    await save(
      { name: "kev", providerId: kev, model: "kev-latest", default: false },
      local.id,
    );
    expect(defaults(await list())).toEqual(["jev"]);
    await save(
      {
        name: "jev2",
        providerId: router,
        model: "jaredpalmer/kev-4b",
        default: true,
      },
      jev.id,
    );
    const renamed = (await list()).find((row) => row.id === jev.id)!;
    expect(renamed).toMatchObject({
      name: "jev2",
      model: "jaredpalmer/kev-4b",
      contextLength: 8192,
      default: true,
    });
    expect(
      (await client.call("DELETE", `/api/deciders/${jev.id}`)).status,
    ).toBe(200);
    expect(defaults(await list())).toEqual(["kev"]);
    expect(logs.events.map((event) => event.msg)).toContain("decider updated");
    expect(
      logs.events.find((event) => event.msg === "decider deleted")?.fields,
    ).toEqual({
      name: "jev2",
      provider: "router",
      model: "jaredpalmer/kev-4b",
    });
  });

  test("refuses a model, a provider or a body the rules do not take", async () => {
    const { save, created, router, gemini } = await admin();
    const refused = async (body: unknown, status: number, words: string) => {
      const res = await save(body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(words);
    };
    const jev = { name: "jev", providerId: router, model: "typesafe/jev-1.13" };
    await refused(
      { ...jev, model: "deepseek/deepseek-chat" },
      400,
      "router does not list deepseek/deepseek-chat as a decision model",
    );
    await refused(
      { ...jev, providerId: gemini },
      400,
      "gemini serves no decision models",
    );
    await refused({ ...jev, providerId: "none" }, 400, "no such provider");
    await refused({ ...jev, name: "J" }, 400, "name must be");
    await refused({ ...jev, extra: 1 }, 400, "unknown field extra");
    await refused({ ...jev, default: "yes" }, 400, "default must be");
    await refused({ ...jev, model: "" }, 400, "model must be");
    await created(jev);
    await refused(jev, 409, "a decider named jev exists");
  });

  test("a provider a decider uses cannot be deleted", async () => {
    const { client, created, router } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    const held = await client.call("DELETE", `/api/providers/${router}`);
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "a decider uses router" });
    await client.call("DELETE", `/api/deciders/${jev.id}`);
    expect(
      (await client.call("DELETE", `/api/providers/${router}`)).status,
    ).toBe(200);
  });

  test("searches the decisions catalog of a provider that serves one", async () => {
    const { client, router, gemini } = await admin();
    const search = (id: string, query: string) =>
      client.call("GET", `/api/providers/${id}/catalog?${query}`);
    const res = await search(router, "q=jev&kind=decisions");
    expect(res.status).toBe(200);
    const { matches } = (await res.json()) as { matches: { id: string }[] };
    expect(matches.map((m) => m.id)).toContain("typesafe/jev-1.13");
    expect(await (await search(router, "q=jev&kind=chat")).json()).toEqual({
      matches: [],
    });
    const unknown = await search(router, "q=jev&kind=images");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: "kind must be chat or decisions",
    });
    const wire = await search(gemini, "q=x&kind=decisions");
    expect(wire.status).toBe(400);
  });

  test("Check answers the fixed yes/no and counts it", async () => {
    const { app, client, created, router, kev } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    const res = await client.call("POST", `/api/deciders/${jev.id}/check`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pick: false,
      probability: 0.89,
      ms: 0,
      cost: 0.000018522,
      served: "typesafe/jev-1.13-20260917",
    });
    const local = await created({
      name: "kev",
      providerId: kev,
      model: "kev-latest",
    });
    const answered = await client.call(
      "POST",
      `/api/deciders/${local.id}/check`,
    );
    expect(await answered.json()).toMatchObject({ cost: null });
    expect(
      app.db
        .query(
          "select decider_name, provider_name, purpose, session_id, cost from decision_usage order by decider_name",
        )
        .all(),
    ).toEqual([
      {
        decider_name: "jev",
        provider_name: "router",
        purpose: "check",
        session_id: null,
        cost: 0.000018522,
      },
      {
        decider_name: "kev",
        provider_name: "kev-serve",
        purpose: "check",
        session_id: null,
        cost: null,
      },
    ]);
  });

  test("a decider's usage and a decision's sum their last 30 days", async () => {
    const { app, client, created, router, kev } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    const local = await created({
      name: "kev",
      providerId: kev,
      model: "kev-latest",
    });
    const read = async (path: string) => {
      app.now.value += 1;
      const res = await client.call("GET", path);
      expect(res.status).toBe(200);
      return (await res.json()) as DecisionUsageResponse;
    };
    expect(await read(`/api/deciders/${jev.id}/usage`)).toMatchObject({
      answers: 0,
      tokens: 0,
      cost: 0,
    });
    await client.call("POST", `/api/deciders/${jev.id}/check`);
    await client.call("POST", `/api/deciders/${jev.id}/check`);
    await client.call("POST", `/api/deciders/${local.id}/check`);
    const priced = await read(`/api/deciders/${jev.id}/usage`);
    expect(priced.answers).toBe(2);
    expect(priced.tokens).toBeGreaterThan(0);
    expect(priced.cost).toBeCloseTo(2 * 0.000018522, 12);
    expect(priced.until - priced.since).toBe(30 * 24 * 60 * 60 * 1000);
    // kev names no cost
    expect(await read(`/api/deciders/${local.id}/usage`)).toMatchObject({
      answers: 1,
      cost: null,
    });
    // a Check is no decision's answer
    expect(await read("/api/decisions/run-attention/usage")).toMatchObject({
      answers: 0,
      cost: 0,
    });
    app.db.run(
      "update decision_usage set purpose = 'run-attention' where decider_name = 'kev'",
    );
    expect(await read("/api/decisions/run-attention/usage")).toMatchObject({
      answers: 1,
    });
    // past the window nothing counts
    app.db.run("update decision_usage set created_at = created_at - ?", [
      31 * 24 * 60 * 60 * 1000,
    ]);
    expect(await read(`/api/deciders/${jev.id}/usage`)).toMatchObject({
      answers: 0,
    });
    for (const path of [
      "/api/deciders/none/usage",
      "/api/decisions/none/usage",
    ]) {
      expect((await client.call("GET", path)).status).toBe(404);
    }
  });

  test("a Check the server refuses is a 502 in the wire's words, logged", async () => {
    const { app, client, created, router, logs } = await admin();
    // listed in the catalog, but the fake server does not know it
    const span = await created({
      name: "span",
      providerId: router,
      model: "respan/span-01",
    });
    const res = await client.call("POST", `/api/deciders/${span.id}/check`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "router answered 404" });
    expect(
      logs.events.find((event) => event.msg === "decider check failed"),
    ).toMatchObject({
      level: "warn",
      area: "deciders",
      fields: {
        name: "span",
        provider: "router",
        model: "respan/span-01",
        error: "router answered 404",
        error_type: "DecisionError",
      },
    });
    expect(
      app.db.query("select count(*) as n from decision_usage").get(),
    ).toEqual({ n: 0 });
    expect((await client.call("POST", "/api/deciders/none/check")).status).toBe(
      404,
    );
  });
});

describe("decisions", () => {
  const ID = "run-attention";
  const PATH = `/api/decisions/${ID}`;
  const [GOOD, BAD] = DECISION_OPTIONS[ID];
  const decisionOf = async (res: Response) =>
    ((await res.json()) as DecisionResponse).decision;
  const listed = async (client: Admin["client"]) =>
    (
      (await (
        await client.call("GET", "/api/decisions")
      ).json()) as DecisionsResponse
    ).decisions;
  const body = (over: Partial<SaveDecisionRequest> = {}) => ({
    enabled: true,
    deciderId: null,
    options: { [GOOD!.key]: GOOD!.description, [BAD!.key]: BAD!.description },
    ...over,
  });
  const count = (app: Admin["app"], table: string) =>
    app.db.query(`select count(*) as n from ${table}`).get();
  const defaults: DecisionSummary = {
    id: ID,
    enabled: true,
    deciderId: null,
    options: DECISION_OPTIONS[ID].map((o) => ({
      key: o.key,
      description: o.description,
      default: o.description,
    })),
  };

  test("are the code's while no row is kept", async () => {
    const { app, client } = await admin();
    expect(await listed(client)).toEqual([defaults]);
    expect(app.deciders.decision(ID)).toEqual(defaults);
    expect(count(app, "decisions")).toEqual({ n: 0 });
  });

  test("a save keeps custom text trimmed and logs no text", async () => {
    const { app, client, logs } = await admin();
    const res = await client.call("PUT", PATH, {
      body: body({
        options: {
          [GOOD!.key]: "  Live data, no errors ",
          [BAD!.key]: BAD!.description,
        },
      }),
    });
    expect(res.status).toBe(200);
    const saved = await decisionOf(res);
    expect(saved.options.map((o) => o.description)).toEqual([
      "Live data, no errors",
      BAD!.description,
    ]);
    expect(saved.options[0]!.default).toBe(GOOD!.description);
    expect(await listed(client)).toEqual([saved]);
    expect(app.deciders.decision(ID)).toEqual(saved);
    // only the changed option keeps a row
    expect(count(app, "decision_options")).toEqual({ n: 1 });
    expect(
      logs.events.filter((event) => event.msg === "decision updated"),
    ).toEqual([
      {
        level: "info",
        area: "deciders",
        msg: "decision updated",
        fields: { decision: ID },
      },
    ]);
  });

  test("the code's text saved again drops the option row", async () => {
    const { app, client } = await admin();
    await client.call("PUT", PATH, {
      body: body({ options: { [GOOD!.key]: "Fine", [BAD!.key]: "Not fine" } }),
    });
    expect(count(app, "decision_options")).toEqual({ n: 2 });
    const res = await client.call("PUT", PATH, {
      body: body({
        options: {
          [GOOD!.key]: GOOD!.description,
          [BAD!.key]: ` ${BAD!.description}`,
        },
      }),
    });
    expect(await decisionOf(res)).toEqual(defaults);
    expect(count(app, "decision_options")).toEqual({ n: 0 });
  });

  test("turns off and names a decider, which falls back when deleted", async () => {
    const { app, client, created, router } = await admin();
    const jev = await created({
      name: "jev",
      providerId: router,
      model: "typesafe/jev-1.13",
    });
    const off = await decisionOf(
      await client.call("PUT", PATH, { body: body({ enabled: false }) }),
    );
    expect(off).toEqual({ ...defaults, enabled: false });
    const named = await decisionOf(
      await client.call("PUT", PATH, {
        body: body({ enabled: false, deciderId: jev.id }),
      }),
    );
    expect(named).toEqual({ ...defaults, enabled: false, deciderId: jev.id });
    expect(
      (await client.call("DELETE", `/api/deciders/${jev.id}`)).status,
    ).toBe(200);
    expect(app.deciders.decision(ID)).toEqual({ ...defaults, enabled: false });
  });

  test("refuses a decider that does not exist and keeps nothing", async () => {
    const { app, client } = await admin();
    const res = await client.call("PUT", PATH, {
      body: body({ deciderId: "none" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no such decider" });
    expect(count(app, "decisions")).toEqual({ n: 0 });
  });

  test("refuses an odd body", async () => {
    const { client } = await admin();
    const long = "x".repeat(MAX_OPTION_TEXT + 1);
    const cases: [unknown, string][] = [
      [
        body({ options: { [GOOD!.key]: "x" } }),
        `options.${BAD!.key} is missing`,
      ],
      [
        body({
          options: { [GOOD!.key]: "x", [BAD!.key]: "y", maybe: "z" },
        }),
        "unknown option maybe",
      ],
      [
        body({ options: { [GOOD!.key]: "   ", [BAD!.key]: "y" } }),
        `options.${GOOD!.key} must be 1 to ${MAX_OPTION_TEXT} characters`,
      ],
      [
        body({ options: { [GOOD!.key]: "x", [BAD!.key]: long } }),
        `options.${BAD!.key} must be 1 to ${MAX_OPTION_TEXT} characters`,
      ],
      [
        body({ options: { [GOOD!.key]: 1, [BAD!.key]: "y" } as never }),
        `options.${GOOD!.key} must be 1 to ${MAX_OPTION_TEXT} characters`,
      ],
      [body({ options: ["x"] as never }), "options must be an object"],
      [body({ enabled: "yes" as never }), "enabled must be true or false"],
      [body({ deciderId: "" }), "deciderId must be an id or null"],
      [{ ...body(), extra: 1 }, "unknown field extra"],
      [["x"], "body must be an object"],
    ];
    for (const [sent, error] of cases) {
      const res = await client.call("PUT", PATH, { body: sent });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    // exactly the cap after the trim is taken
    const res = await client.call("PUT", PATH, {
      body: body({
        options: {
          [GOOD!.key]: ` ${"x".repeat(MAX_OPTION_TEXT)} `,
          [BAD!.key]: "y",
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  test("an unknown decision is a 404", async () => {
    const { client } = await admin();
    const res = await client.call("PUT", "/api/decisions/none", {
      body: body(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such decision" });
  });
});
