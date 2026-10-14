// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed's address on Home and a project's Feed tab: arriving reads
// the whole route, a search or a pick after that reads only the
// session list, and reload() reads the whole route again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reload, startLoading } from "../../../src/client/app/loading.ts";
import { path, query } from "../../../src/client/app/router.ts";
import { me } from "../../../src/client/data/me.ts";

let calls: string[] = [];
let user = 0;
const realFetch = globalThis.fetch;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const answer = (url: string): Response =>
  url === "/api/projects"
    ? Response.json({
        projects: [{ id: "p0", kind: "personal", name: "stefan" }],
      })
    : url.startsWith("/api/sessions?") || url === "/api/sessions"
      ? Response.json({ rows: [], next: null })
      : Response.json({ error: "no" }, { status: 404 });

beforeEach(() => {
  // a new user each test, so nothing held carries over
  user++;
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return answer(url);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  me.value = undefined;
  path.value = "/";
  query.value = "";
  await settle();
  globalThis.fetch = realFetch;
});

// arrives at the page signed in, then each address in turn: what each
// read
async function visit(page: string, searches: string[]) {
  path.value = page;
  query.value = "";
  me.value = {
    id: `u${user}`,
    username: "stefan",
    fullName: "Stefan",
    role: "member",
    mustChangePassword: false,
  };
  const stop = startLoading();
  try {
    await settle();
    await settle();
    const arrival = calls;
    const after: string[][] = [];
    for (const search of searches) {
      calls = [];
      query.value = search;
      await settle();
      after.push(calls);
    }
    calls = [];
    await reload();
    return { arrival, after, reloaded: calls };
  } finally {
    stop();
  }
}

// what each route's whole load reads, the list under no search
const WHOLE = {
  "/": [
    "GET /api/sessions",
    "GET /api/usage/week?tz=UTC",
    "GET /api/me/not-sent",
    "GET /api/external-tasks?waiting=1",
    "GET /api/projects",
    "GET /api/projects/p0/agents",
    "GET /api/projects/p0/uploads",
  ],
  "/projects/p1": [
    "GET /api/projects/p1",
    "GET /api/projects/p1/agents",
    "GET /api/projects/p1/automations",
    "GET /api/projects/p1/external-tasks",
    "GET /api/usage/days?tz=UTC&weeks=16",
    "GET /api/sessions?project=p1",
    "GET /api/projects/p1/uploads",
  ],
};

describe("the feed's address", () => {
  for (const [name, page, project] of [
    ["Home", "/", ""],
    ["a project's Feed tab", "/projects/p1", "project=p1&"],
  ] as const) {
    test.serial(
      `${name} reads only the list on a search or a pick`,
      async () => {
        const whole = WHOLE[page];
        const { arrival, after, reloaded } = await visit(page, [
          "?q=s",
          "?q=sweep",
          "?q=sweep&origin=chat",
          "?attention=1",
        ]);
        // arriving: the rail's list on the sign in, then the whole route
        expect(arrival.toSorted()).toEqual(
          ["GET /api/projects", ...whole].toSorted(),
        );
        expect(after).toEqual([
          [`GET /api/sessions?${project}q=s`],
          [`GET /api/sessions?${project}q=sweep`],
          [`GET /api/sessions?${project}q=sweep&origin=chat`],
          [`GET /api/sessions?${project}attention=1`],
        ]);
        // reload is the whole route again, under the address's pick
        expect(reloaded.toSorted()).toEqual(
          whole
            .map((c) =>
              c.startsWith("GET /api/sessions")
                ? `GET /api/sessions?${project}attention=1`
                : c,
            )
            .toSorted(),
        );
      },
    );
  }
});
