// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { apply } from "../../../src/server/provision/apply.ts";
import { client } from "../../../src/server/provision/client.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import { MAX_WEB_DOMAINS } from "../../../src/shared/web.ts";
import { testApp } from "../../helpers/app.ts";
import {
  changes,
  documents,
  loginCount,
  mutations,
  network,
  object,
  provider,
  recompose,
  snapshot,
} from "./helpers.ts";

const ignore = () => {};
const web = (spec: Record<string, unknown>) => object("Tool", "web", spec);
const search = (provider: string | null) =>
  object("Tool", "websearch", { provider });

describe("provision web parsing", () => {
  test("normalizes hosts while keeping mode and domains omissions", () => {
    expect(documents(web({ mode: "listed" }))[0]?.spec).toEqual({
      mode: "listed",
    });
    expect(
      documents(
        web({
          domains: [
            " DOCS.example.test. ",
            "docs.example.test",
            "bücher.test",
            "[::1]",
            "",
          ],
        }),
      )[0]?.spec,
    ).toEqual({
      domains: ["[::1]", "docs.example.test", "xn--bcher-kva.test"],
    });
    for (const mode of ["off", "all", "listed"] as const) {
      expect(documents(web({ mode }))[0]?.spec).toEqual({ mode });
    }
    expect(documents(search(null))[0]?.spec).toEqual({ provider: null });
  });

  test.each([
    {},
    { mode: "unknown" },
    { mode: "ALL" },
    { mode: null },
    { mode: false },
    { domains: null },
    { domains: "docs.example.test" },
    { domains: [123] },
    { domains: ["*.example.test"] },
    { domains: ["https://docs.example.test"] },
    { domains: ["docs.example.test/path"] },
    { domains: ["docs.example.test:80"] },
    { domains: ["docs.example.test:443"] },
    { domains: ["[::1]:80"] },
    { domains: ["docs.example.test?query"] },
    { domains: ["user@docs.example.test"] },
    { domains: ["docs.example.test#fragment"] },
    { domains: ["a".repeat(254)] },
    {
      domains: Array.from(
        { length: MAX_WEB_DOMAINS + 1 },
        (_, index) => `host-${index}.test`,
      ),
    },
  ])("refuses invalid web fields before apply: %j", (spec) => {
    expect(() => documents(web(spec))).toThrow(
      /instance.yaml: Tool\/web: spec\./,
    );
  });

  test.each([
    object("Tool", "webfetch", {}),
    object("Tool", "webfetch", { enabled: true }),
    object("Tool", "webfetch", { enabled: false }),
    object("Tool", "websearch", { enabled: true }),
    object("Tool", "websearch", { provider: null, enabled: false }),
    object("Tool", "websearch", {}),
    object("Tool", "websearch", { domains: [] }),
    object("Tool", "web", { enabled: true }),
    object("Tool", "web", { hosts: [] }),
    object("Tool", "web", { provider: null }),
    object("Tool", "visualize", { mode: "off" }),
    object("Tool", "visualize", { provider: null }),
    object("Automation", "task", { disabledCapabilities: ["web"] }),
  ])("refuses old switches and unrelated fields: %j", (input) => {
    expect(() => documents(input)).toThrow("instance.yaml:");
  });
});

test.each([
  ["web", { mode: "off" }],
  ["web", { domains: ["next.example.test"] }],
  ["websearch", { provider: null }],
  ["visualize", { enabled: false }],
  ["visualize", { hosts: [] }],
] satisfies [string, Record<string, unknown>][])(
  "plans only supplied %s fields: %j",
  async (name, spec) => {
    const writes: { path: string; body: unknown }[] = [];
    const api = client(async (request) => {
      if (request.method === "GET") {
        return Response.json({
          access: { mode: "listed", domains: ["docs.example.test"] },
          search: { provider: "exa" },
          visualize: { enabled: true, hosts: ["https://assets.example.test"] },
        });
      }
      expect(request.method).toBe("PATCH");
      writes.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json({});
    });
    const reports: string[] = [];
    await apply(
      api,
      documents(object("Tool", name, spec)),
      () => null,
      (action) => reports.push(action),
    );
    expect(writes).toEqual([{ path: `/api/tools/${name}`, body: spec }]);
    expect(reports).toEqual(["updated"]);
  },
);

describe("provision web through the composed app", () => {
  test("a fresh instance keeps all domains and None, with no object writes on reapply", async () => {
    const app = await testApp({ activate: false });
    try {
      const docs = documents(web({ mode: "all" }), search(null));
      expect(() => app.provision.validate(docs)).not.toThrow();
      expect(await app.provision.apply(docs, ignore)).toEqual({
        created: 0,
        updated: 0,
        unchanged: 2,
      });
      const writes = mutations(app.db);
      expect(await app.provision.apply(docs, ignore)).toEqual({
        created: 0,
        updated: 0,
        unchanged: 2,
      });
      expect(writes()).toEqual([]);
      expect(loginCount(app.db)).toBe(0);
    } finally {
      await app.shutdown();
    }
  });

  test("applies None and web changes independently, preserving omitted fields and visuals", async () => {
    const fake = network();
    const app = await testApp({ activate: false, fetcher: fake.fetcher });
    try {
      await app.provision.apply(
        documents(
          web({ mode: "listed", domains: ["DOCS.example.test."] }),
          search("exa"),
          object("Tool", "visualize", {
            enabled: false,
            hosts: ["https://assets.example.test"],
          }),
        ),
        ignore,
      );
      const client = app.client();
      await client.login("admin", "hunter2-test");
      const tools = async (): Promise<ToolsResponse> =>
        (await client.call("GET", "/api/tools")).json();
      const before = await tools();
      expect(before).toMatchObject({
        access: { mode: "listed", domains: ["docs.example.test"] },
        search: { provider: "exa" },
        visualize: { enabled: false, hosts: ["https://assets.example.test"] },
      });
      app.now.value++;
      expect(
        await app.provision.apply(documents(search(null)), ignore),
      ).toEqual({ created: 0, updated: 1, unchanged: 0 });
      const none = await tools();
      expect(none.search.provider).toBeNull();
      expect(none.access).toEqual(before.access);
      expect(none.visualize).toEqual(before.visualize);

      for (const [spec, expected] of [
        [{ mode: "off" }, { mode: "off", domains: ["docs.example.test"] }],
        [
          { domains: ["NEXT.example.test."] },
          { mode: "off", domains: ["next.example.test"] },
        ],
        [
          { mode: "listed" },
          { mode: "listed", domains: ["next.example.test"] },
        ],
        [
          { domains: ["only.example.test"] },
          { mode: "listed", domains: ["only.example.test"] },
        ],
        [{ mode: "all" }, { mode: "all", domains: ["only.example.test"] }],
        [{ domains: [] }, { mode: "all", domains: [] }],
      ] satisfies [Record<string, unknown>, unknown][]) {
        app.now.value++;
        const docs = documents(web(spec));
        const parsed = JSON.stringify(docs);
        const state = snapshot(app.db);
        const count = changes(app.db);
        expect(() => app.provision.validate(docs)).not.toThrow();
        expect(snapshot(app.db)).toEqual(state);
        expect(changes(app.db)).toBe(count);
        expect(await app.provision.apply(docs, ignore)).toEqual({
          created: 0,
          updated: 1,
          unchanged: 0,
        });
        expect(JSON.stringify(docs)).toBe(parsed);
        const current = await tools();
        expect(current.access).toMatchObject(expected);
        expect(current.search).toEqual(none.search);
        expect(current.visualize).toEqual(before.visualize);
      }
      const writes = mutations(app.db);
      const docs = documents(web({ mode: "all" }), search(null));
      expect(await app.provision.apply(docs, ignore)).toEqual({
        created: 0,
        updated: 0,
        unchanged: 2,
      });
      expect(writes()).toEqual([]);
      await client.call("POST", "/api/logout");
      expect(loginCount(app.db)).toBe(0);
      expect(fake.calls).toEqual([]);
    } finally {
      await app.shutdown();
    }
  });

  test.each([{ mode: "listed" }, { mode: "listed", domains: ["", " "] }])(
    "offline listed refusal precedes bootstrap and earlier object writes: %j",
    async (spec) => {
      const fake = network();
      const app = await testApp({ activate: false, fetcher: fake.fetcher });
      try {
        const docs = documents(provider(), web(spec));
        const before = snapshot(app.db);
        const count = changes(app.db);
        const message =
          "instance.yaml: Tool/web: spec.domains list at least one host";
        expect(() => app.provision.validate(docs)).toThrow(message);
        await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
          message,
        );
        expect(snapshot(app.db)).toEqual(before);
        expect(changes(app.db)).toBe(count);
        expect(app.users.count()).toBe(0);
        expect(fake.calls).toEqual([]);
      } finally {
        await app.shutdown();
      }
    },
  );

  test("offline validation uses stored mode and hosts after recomposition", async () => {
    const fake = network();
    const app = await testApp({ activate: false, fetcher: fake.fetcher });
    try {
      await app.provision.apply(
        documents(web({ mode: "off", domains: ["docs.example.test"] })),
        ignore,
      );
      const next = await recompose(app, fake.fetcher);
      try {
        const listed = documents(web({ mode: "listed" }));
        const before = snapshot(app.db);
        expect(() => next.provision.validate(listed)).not.toThrow();
        expect(snapshot(app.db)).toEqual(before);
        expect(await next.provision.apply(listed, ignore)).toEqual({
          created: 0,
          updated: 1,
          unchanged: 0,
        });
        const saved = snapshot(app.db);
        const count = changes(app.db);
        const empty = documents(web({ domains: [] }));
        expect(() => next.provision.validate(empty)).toThrow("spec.domains");
        await expect(next.provision.apply(empty, ignore)).rejects.toThrow(
          "spec.domains",
        );
        expect(snapshot(app.db)).toEqual(saved);
        expect(changes(app.db)).toBe(count);
        expect(loginCount(app.db)).toBe(0);
        expect(fake.calls).toEqual([]);
      } finally {
        await next.shutdown();
      }
    } finally {
      await app.shutdown();
    }
  });
});
