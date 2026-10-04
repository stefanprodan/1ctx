// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createMcp } from "../../../scripts/load/fake-mcp.ts";
import { createModel } from "../../../scripts/load/fake-model.ts";
import { checkTarget } from "../../../scripts/load/kind.ts";
import {
  type Counts,
  memberships,
  names,
  provisionFiles,
  valuesYaml,
} from "../../../scripts/load/provision.ts";
import { parse } from "../../../src/server/provision/index.ts";
import { testApp } from "../../helpers/app.ts";

const COUNTS: Counts = { admins: 2, members: 12, teams: 3, agents: 2 };
const NS = "1ctx-test";

// the fakes answer every request the provision makes, whatever the host
function fakes(): typeof fetch {
  const model = createModel({ log: () => {} });
  const mcp = createMcp({ sleep: async () => {}, log: () => {} });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    return path.startsWith("/v1/") ? model.fetch(req) : mcp.fetch(req);
  }) as typeof fetch;
}

describe("the kind provision", () => {
  test("runs only on a kind context and a 1ctx namespace", () => {
    expect(() => checkTarget("kind-flux", "1ctx-load")).not.toThrow();
    expect(() => checkTarget("prod-cluster", "1ctx-load")).toThrow("context");
    expect(() => checkTarget("kind-flux", "default")).toThrow("namespace");
  });

  test("is the same for a count and a namespace", () => {
    expect(provisionFiles(COUNTS, NS)).toEqual(provisionFiles(COUNTS, NS));
    const values = valuesYaml(provisionFiles(COUNTS, NS));
    expect(values).toContain("secureCookie: false");
    expect(values).toContain(`http://fake-model.${NS}.svc:1241/v1`);
  });

  test("puts every member in two to five teams", () => {
    const byTeam = memberships(COUNTS);
    const per = new Map<string, number>();
    for (const list of byTeam.values()) {
      for (const u of list) per.set(u, (per.get(u) ?? 0) + 1);
    }
    expect(per.size).toBe(COUNTS.members);
    for (const n of per.values()) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  test("applies with the real provision on a throwaway database", async () => {
    const n = names(COUNTS);
    const secrets = Object.fromEntries(
      [...n.admins, ...n.members].map((u) => [`user-${u}`, `password-${u}`]),
    );
    const app = await testApp({ activate: false, fetcher: fakes(), secrets });
    try {
      const files = provisionFiles(COUNTS, NS);
      const documents = parse(
        Object.entries(files).map(([path, text]) => ({ path, text })),
      );
      await app.provision.apply(documents, () => {});
      const count = (sql: string) =>
        app.db.query<{ n: number }, []>(sql).get()!.n;
      expect(count("select count(*) as n from users")).toBe(1 + 2 + 12);
      expect(
        count("select count(*) as n from projects where kind = 'team'"),
      ).toBe(3);
      expect(count("select count(*) as n from agents")).toBe(2);
      expect(count("select count(*) as n from mcp_tools")).toBe(93);
      const urls = app.db
        .query<{ base_url: string }, []>("select base_url from providers")
        .all();
      expect(urls).toEqual([
        { base_url: `http://fake-model.${NS}.svc:1241/v1` },
      ]);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});
