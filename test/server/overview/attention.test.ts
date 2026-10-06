// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What needs attention: the list from the config rows, keys first by
// kind and name, then failed refreshes newest first, and the route over
// a composed app whose key files come and go.

import { describe, expect, test } from "bun:test";
import {
  type AttentionInput,
  attention,
} from "../../../src/server/overview/index.ts";
import type { AttentionResponse } from "../../../src/shared/api/admin.ts";
import { PROVIDER_URL, testApp } from "../../helpers/app.ts";

const none: AttentionInput = {
  providers: [],
  mcp: [],
  skills: [],
  credentials: [],
  search: { provider: null, hasKey: false },
  email: null,
};

describe("attention", () => {
  test("is empty when every key is there and nothing failed", () => {
    expect(attention(none)).toEqual([]);
    expect(
      attention({
        providers: [
          { name: "open", keyName: "provider-open", hasKey: true },
          { name: "local", keyName: null, hasKey: false },
        ],
        mcp: [
          {
            name: "docs",
            keyName: null,
            hasKey: false,
            refreshFailedAt: null,
          },
        ],
        skills: [{ name: "plan", refreshFailedAt: null }],
        credentials: [{ name: "gh", key: "ok" }],
        search: { provider: null, hasKey: false },
        email: null,
      }),
    ).toEqual([]);
  });

  test("puts missing keys first, then refreshes newest first", () => {
    const items = attention({
      providers: [
        { name: "zeta", keyName: "provider-zeta", hasKey: false },
        { name: "alpha", keyName: "provider-alpha", hasKey: false },
      ],
      mcp: [
        {
          name: "github",
          keyName: "mcp-github",
          hasKey: false,
          refreshFailedAt: 100,
        },
      ],
      skills: [
        { name: "old", refreshFailedAt: 50 },
        { name: "new", refreshFailedAt: 300 },
      ],
      credentials: [
        { name: "grafana", key: "unusable" },
        { name: "gh", key: "missing" },
      ],
      search: { provider: "exa", hasKey: false },
      email: null,
    });
    expect(items).toEqual([
      { kind: "provider-key", name: "alpha", at: null },
      { kind: "provider-key", name: "zeta", at: null },
      { kind: "mcp-key", name: "github", at: null },
      { kind: "credential-key", name: "gh", at: null },
      { kind: "credential-unusable", name: "grafana", at: null },
      { kind: "search-key", name: "exa", at: null },
      { kind: "skill-refresh", name: "new", at: 300 },
      { kind: "mcp-refresh", name: "github", at: 100 },
      { kind: "skill-refresh", name: "old", at: 50 },
    ]);
  });
});

describe("email's attention", () => {
  test("puts paused link emails after the key files", () => {
    // paused only while email is on, so its key file is there
    const email = {
      keyName: "email-relay",
      hasKey: true,
      queued: 0,
      failed: 0,
      lastFailure: null,
      lastFailedAt: null,
      linksPaused: true,
    };
    const search = { provider: "exa" as const, hasKey: false };
    expect(attention({ ...none, search, email })).toEqual([
      { kind: "search-key", name: "exa", at: null },
      { kind: "links-paused", name: "Link emails", at: null },
    ]);
    expect(
      attention({ ...none, email: { ...email, linksPaused: false } }),
    ).toEqual([]);
  });
});

describe("the attention route", () => {
  test("follows the key files and the search service", async () => {
    const secrets: Record<string, string> = {
      "provider-router": "sk-router",
    };
    const app = await testApp({ secrets });
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    const made = await admin.call("POST", "/api/providers", {
      body: {
        name: "router",
        wire: "openrouter",
        baseUrl: PROVIDER_URL,
        keyName: "provider-router",
      },
    });
    expect(made.status).toBe(201);
    const read = async (): Promise<AttentionResponse> => {
      const res = await admin.call("GET", "/api/admin/attention");
      expect(res.status).toBe(200);
      return res.json();
    };
    expect((await read()).items).toEqual([]);
    delete secrets["provider-router"];
    app.db
      .query("update tools set provider = 'exa' where name = 'websearch'")
      .run();
    expect((await read()).items).toEqual([
      { kind: "provider-key", name: "router", at: null },
      { kind: "search-key", name: "exa", at: null },
    ]);
    secrets["search-exa"] = "exa-key";
    expect((await read()).items).toEqual([
      { kind: "provider-key", name: "router", at: null },
    ]);
    const odd = await admin.call("GET", "/api/admin/attention?tz=UTC");
    expect(odd.status).toBe(400);
    await app.shutdown();
  });
});
