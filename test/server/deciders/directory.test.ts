// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deciders in the Directory, open to every signed-in user: the
// list and a decider's page name the provider and the decisions it
// answers now, never a provider id, a base URL or a decision's text;
// the days count its answers in every project, an admin's Check left
// out.

import { describe, expect, spyOn, test } from "bun:test";
import { DecisionUsageStore } from "../../../src/server/usage/decisions.ts";
import type {
  DirectoryDeciderDaysResponse,
  DirectoryDeciderResponse,
} from "../../../src/shared/api/directory.ts";
import { DECISION_OPTIONS } from "../../../src/shared/contracts/decision.ts";
import {
  hashPassword,
  KEV_URL,
  PROVIDER_URL,
  type TestApp,
  testApp,
} from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

const DAY_MS = 86_400_000;

async function setup() {
  const app = await testApp({ secrets: { "provider-router": "sk-router" } });
  app.now.value = Date.parse("2026-09-16T10:00:00Z");
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const provider = async (name: string, wire: string, baseUrl: string) => {
    const res = await admin.call("POST", "/api/providers", {
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
  const decider = async (body: unknown): Promise<string> => {
    const res = await admin.call("POST", "/api/deciders", { body });
    expect(res.status).toBe(201);
    return ((await res.json()) as { decider: { id: string } }).decider.id;
  };
  const jev = await decider({
    name: "jev",
    providerId: router,
    model: "typesafe/jev-1.13",
  });
  const local = await decider({
    name: "kev",
    providerId: kev,
    model: "kev-latest",
  });
  app.createUser({
    username: "casey",
    fullName: "Casey",
    email: "casey@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const member = app.client();
  expect((await member.login("casey", "password-test")).status).toBe(200);
  const decide = (body: { enabled: boolean; deciderId: string | null }) =>
    admin.call("PUT", "/api/decisions/run-attention", {
      body: {
        ...body,
        options: Object.fromEntries(
          DECISION_OPTIONS["run-attention"].map((o) => [
            o.key,
            `${o.description} (admin text)`,
          ]),
        ),
      },
    });
  return { app, admin, member, router, kev, jev, local, decide };
}

function answer(
  app: TestApp,
  deciderId: string,
  purpose: string,
  inputTokens: number | null,
  at: number,
) {
  app.db.run(
    `insert into decision_usage (id, decider_id, decider_name, provider_id,
       provider_name, model, purpose, session_id, project_id, input_tokens,
       output_tokens, cost, duration, created_at)
     values (?, ?, 'x', 'p', 'router', 'm', ?, null, null, ?, null, 0.5, 1, ?)`,
    [crypto.randomUUID(), deciderId, purpose, inputTokens, at],
  );
}

describe("the deciders in the directory", () => {
  test("a member lists every decider by name, with no decisions", async () => {
    const { admin, member, jev, local } = await setup();
    const res = await member.call("GET", "/api/directory/deciders");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deciders: [
        { id: jev, name: "jev", default: true, model: "typesafe/jev-1.13" },
        { id: local, name: "kev", default: false, model: "kev-latest" },
      ],
    });
    expect((await admin.call("GET", "/api/directory/deciders")).status).toBe(
      200,
    );
    expect(
      (await member.call("GET", "/api/directory/deciders?x=1")).status,
    ).toBe(400);
  });

  test("a page lists the decisions naming it, and those naming none on the default", async () => {
    const { admin, member, kev, local, decide } = await setup();
    const answers = async (name: string) =>
      (
        (await (
          await member.call("GET", `/api/directory/deciders/${name}`)
        ).json()) as DirectoryDeciderResponse
      ).decisions;
    // no decision names a decider, so the default answers it
    expect(await answers("jev")).toEqual(["run-attention"]);
    expect(await answers("kev")).toEqual([]);
    // the mark moves, and the decisions naming none follow it
    const moved = await admin.call("PATCH", `/api/deciders/${local}`, {
      body: {
        name: "kev",
        providerId: kev,
        model: "kev-latest",
        default: true,
      },
    });
    expect(moved.status).toBe(200);
    expect(await answers("jev")).toEqual([]);
    expect(await answers("kev")).toEqual(["run-attention"]);
    // a decision naming a decider stays with it whoever is the default
    const jevId = (
      (await (
        await member.call("GET", "/api/directory/deciders/jev")
      ).json()) as DirectoryDeciderResponse
    ).decider.id;
    expect((await decide({ enabled: true, deciderId: jevId })).status).toBe(
      200,
    );
    expect(await answers("jev")).toEqual(["run-attention"]);
    expect(await answers("kev")).toEqual([]);
    // a turned-off decision asks nobody
    await decide({ enabled: false, deciderId: jevId });
    expect(await answers("jev")).toEqual([]);
    expect(await answers("kev")).toEqual([]);
  });

  test("a decider's page names its provider and model, never the provider's id or a decision's text", async () => {
    const { admin, member, router, jev, decide } = await setup();
    await decide({ enabled: true, deciderId: null });
    for (const client of [member, admin]) {
      const res = await client.call("GET", "/api/directory/deciders/jev");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(router);
      expect(text).not.toContain(PROVIDER_URL);
      expect(text).not.toContain("provider-router");
      expect(text).not.toContain("admin text");
      const body = JSON.parse(text) as DirectoryDeciderResponse;
      expect(body).toEqual({
        decider: {
          id: jev,
          name: "jev",
          model: "typesafe/jev-1.13",
          contextLength: 32000,
          promptPrice: expect.any(Number),
          default: true,
          createdAt: expect.any(Number),
        },
        provider: "router",
        decisions: ["run-attention"],
      });
    }
    const kev: DirectoryDeciderResponse = await (
      await member.call("GET", "/api/directory/deciders/kev")
    ).json();
    expect(kev.provider).toBe("kev-serve");
    expect(kev.decisions).toEqual([]);
    const list = await (
      await member.call("GET", "/api/directory/deciders")
    ).text();
    expect(list).not.toContain(router);
    expect(list).not.toContain("admin text");
  });

  test("an unknown name is a 404, a malformed one the parser's 400", async () => {
    const { member } = await setup();
    const cases: [string, number][] = [
      ["/api/directory/deciders/nobody", 404],
      ["/api/directory/deciders/nobody/days?tz=UTC", 404],
      ["/api/directory/deciders/Jev", 400],
      ["/api/directory/deciders/a.b/days?tz=UTC", 400],
      ["/api/directory/deciders/jev/days", 400],
      ["/api/directory/deciders/jev/days?tz=Mars%2FOlympus", 400],
      ["/api/directory/deciders/jev/days?tz=UTC&weeks=16", 400],
    ];
    for (const [path, status] of cases) {
      expect((await member.call("GET", path)).status, path).toBe(status);
    }
  });

  test("the days count the decider's answers in the caller's zone, a Check left out", async () => {
    const { app, member, jev, local } = await setup();
    const now = app.now.value;
    answer(app, jev, "run-attention", 100, now - 60_000);
    answer(app, jev, "run-attention", null, now - 120_000);
    answer(app, jev, "run-attention", 40, now - 3 * DAY_MS);
    // an admin's Check and another decider's answer are not this one's
    answer(app, jev, "check", 1_000, now - 60_000);
    answer(app, local, "run-attention", 1_000, now - 60_000);
    // before the year, nothing counts
    answer(app, jev, "run-attention", 1_000, now - 400 * DAY_MS);

    const res = await member.call(
      "GET",
      "/api/directory/deciders/jev/days?tz=UTC",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryDeciderDaysResponse;
    expect(Object.keys(body).sort()).toEqual([
      "days",
      "since",
      "total",
      "until",
      "usage",
    ]);
    expect(body.since).toBe(Date.parse("2025-09-15T00:00:00Z"));
    expect(body.until).toBe(Date.parse("2026-09-17T00:00:00Z"));
    expect(body.days).toHaveLength(367);
    expect(body.usage).toHaveLength(body.days.length);
    expect(body.usage.at(-1)).toEqual({ answers: 2, tokens: 100 });
    expect(body.usage[body.days.indexOf("2026-09-13")]).toEqual({
      answers: 1,
      tokens: 40,
    });
    expect(body.total).toEqual({ answers: 3, tokens: 140 });
    expect(JSON.stringify(body)).not.toContain("cost");

    // a day is the caller's: ten past midnight in Bucharest is yesterday
    // in UTC
    answer(app, local, "run-attention", 5, Date.parse("2026-09-15T21:10:00Z"));
    const there: DirectoryDeciderDaysResponse = await (
      await member.call(
        "GET",
        "/api/directory/deciders/kev/days?tz=Europe%2FBucharest",
      )
    ).json();
    expect(there.usage.at(-1)).toEqual({ answers: 2, tokens: 1_005 });
  });

  test("an empty year is all zeros", async () => {
    const { member } = await setup();
    const body: DirectoryDeciderDaysResponse = await (
      await member.call("GET", "/api/directory/deciders/kev/days?tz=UTC")
    ).json();
    expect(body.total).toEqual({ answers: 0, tokens: 0 });
    expect(body.usage.every((d) => d.answers === 0 && d.tokens === 0)).toBe(
      true,
    );
  });
});

test("a decider's days seek its covering index by time", () => {
  const db = memoryDb();
  const query = spyOn(db, "query");
  let sql: string;
  try {
    new DecisionUsageStore(db).deciderDays("x", [0], 1);
    expect(query).toHaveBeenCalledTimes(1);
    sql = query.mock.calls[0]![0];
  } finally {
    query.mockRestore();
  }
  const plan = db
    .query<{ detail: string }, [number, string, string]>(
      `explain query plan ${sql}`,
    )
    .all(1, "[0]", "x")
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain(
    "USING COVERING INDEX decision_usage_decider (decider_id=? AND created_at>? AND created_at<?)",
  );
  db.close();
});
