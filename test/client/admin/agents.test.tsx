// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words the agents page shows, the search that keeps only the
// latest answer, the two entities that follow the signed-in user, the
// Admin group in the rail, and the page rendered over the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { shortModel } from "../../../src/client/agents/meta.ts";
import { railRows } from "../../../src/client/app/routes.ts";
import {
  agents,
  agentsError,
  loadAgents,
} from "../../../src/client/data/agents.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  createProvider,
  deleteProvider,
  loadProviders,
  providers,
  providersError,
  searchCatalog,
} from "../../../src/client/data/providers.ts";
import { limits } from "../../../src/client/data/tools.ts";
import {
  compactLine,
  defaultThinking,
  effortApplies,
  effortChoices,
  keyLine,
  nameProblem,
  preset,
  priceLine,
  reserveOf,
  sentEffort,
  thinkingChoices,
  thinkingLine,
  windowLine,
} from "../../../src/client/views/admin/Agents.model.ts";
import { CatalogSearch } from "../../../src/client/views/admin/Agents.state.ts";
import { Agents } from "../../../src/client/views/admin/Agents.tsx";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../src/shared/contracts/provider.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};
const router: ProviderSummary = {
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: "http://models.test/v1",
  keyName: "router",
  hasKey: false,
  createdAt: 0,
};
const flash: CatalogMatch = {
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek: V4 Flash",
  contextLength: 128000,
  promptPrice: 0.14,
  completionPrice: 0.28,
  tools: true,
  reasoning: true,
};
const coder: AgentSummary = {
  id: "ag1",
  name: "coder",
  avatar: "bot",
  providerId: "pr1",
  model: flash,
  thinking: null,
  effort: null,
  prompt: "",
  createdAt: 0,
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  me.value = admin;
  providers.value = null;
  providersError.value = null;
  agents.value = null;
  agentsError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the words", () => {
  test("the model's own name, the org gone", () => {
    expect(shortModel("openrouter/free")).toBe("free");
    expect(shortModel("stefanprodan/Ornith-1.5-35B-A3B")).toBe(
      "Ornith-1.5-35B-A3B",
    );
    expect(shortModel("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  test("window, price and key", () => {
    expect(windowLine(128000)).toBe("128k");
    expect(windowLine(1048576)).toBe("1M");
    expect(windowLine(null)).toBe("");
    expect(priceLine(0.14, 0.28)).toBe("$0.14 / $0.28");
    expect(priceLine(0, 0)).toBe("free");
    expect(priceLine(null, 1)).toBe("");
    expect(keyLine(null, false)).toBe("no key");
    expect(keyLine("router", true)).toBe("router.key");
    expect(keyLine("router", false)).toBe("router.key missing");
    expect(nameProblem("")).toBe("Enter a name");
    expect(nameProblem("Coder")).toContain("lowercase");
    expect(nameProblem("coder")).toBeNull();
    expect(preset("openrouter").baseUrl).toContain("/api/v1");
    expect(preset("openai-compatible").baseUrl).toBeNull();
  });

  test("thinking and effort: the default and the wire's levels", () => {
    expect(defaultThinking(flash)).toBe("on");
    expect(defaultThinking({ ...flash, reasoning: false })).toBe("off");
    expect(defaultThinking(null)).toBe("off");
    expect(thinkingChoices(flash)[0]).toEqual({
      value: null,
      label: "Default (on)",
    });
    expect(effortChoices("openrouter").map((c) => c.value)).toEqual([
      null,
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortChoices("openai-compatible").map((c) => c.value)).toEqual([
      null,
      "low",
      "medium",
      "high",
    ]);
    expect(effortApplies(flash, null)).toBe(true);
    expect(effortApplies({ ...flash, reasoning: false }, null)).toBe(false);
    expect(effortApplies({ ...flash, reasoning: false }, "on")).toBe(true);
    expect(effortApplies(flash, "off")).toBe(false);
    expect(thinkingLine({ thinking: null, effort: null })).toBe("");
    expect(thinkingLine({ thinking: "off", effort: "high" })).toBe(
      "thinking off",
    );
    expect(thinkingLine({ thinking: "on", effort: "high" })).toBe(
      "thinking on · effort high",
    );
    expect(thinkingLine({ thinking: null, effort: "low" })).toBe("effort low");
  });

  test("where a model compacts, by the runner's formula", () => {
    expect(reserveOf(null)).toBeNull();
    const rows = [
      {
        name: "contextReserve" as const,
        value: 20_000,
        default: 20_000,
        min: 1000,
        max: 200_000,
        unit: "tokens" as const,
        scope: "send" as const,
        changedAt: null,
      },
    ];
    expect(reserveOf(rows)).toBe(20_000);
    expect(compactLine(128000, 20_000)).toBe("auto compaction at 108k");
    // a small window keeps a quarter, not the whole reserve
    expect(compactLine(16000, 20_000)).toBe("auto compaction at 12k");
    expect(compactLine(null, 20_000)).toBe("no auto compaction");
    expect(compactLine(128000, null)).toBe("");
  });

  test("the effort sent follows the choices and the wire", () => {
    expect(sentEffort(flash, null, "high", "openrouter")).toBe("high");
    expect(sentEffort(flash, "off", "high", "openrouter")).toBeNull();
    expect(
      sentEffort({ ...flash, reasoning: false }, null, "high", "openrouter"),
    ).toBeNull();
    // a level picked on OpenRouter does not survive a move to a plain server
    expect(sentEffort(flash, "on", "xhigh", "openai-compatible")).toBeNull();
    expect(sentEffort(flash, "on", "high", "openai-compatible")).toBe("high");
    expect(sentEffort(flash, "on", "high", undefined)).toBeNull();
  });
});

describe("CatalogSearch", () => {
  test("keeps only the latest answer and clears with the field", async () => {
    const gates: { q: string; open: (m: CatalogMatch[]) => void }[] = [];
    const s = new CatalogSearch(
      (q) => new Promise((open) => gates.push({ q, open })),
      0,
    );
    s.type("de");
    expect(s.busy.value).toBe(true);
    await new Promise((r) => setTimeout(r, 1));
    s.type("deep");
    await new Promise((r) => setTimeout(r, 1));
    expect(gates.map((g) => g.q)).toEqual(["de", "deep"]);
    gates[1].open([flash]);
    await Promise.resolve();
    expect(s.matches.value).toEqual([flash]);
    expect(s.busy.value).toBe(false);
    gates[0].open([]);
    await Promise.resolve();
    expect(s.matches.value).toEqual([flash]);
    s.clear();
    expect(s.matches.value).toEqual([]);
    expect(s.query.value).toBe("");
  });

  test("a failure is the answer, and nothing lands after dispose", async () => {
    let fail = true;
    const s = new CatalogSearch(async () => {
      if (fail) throw new Error("the provider did not answer");
      return [flash];
    }, 0);
    s.type("x");
    await new Promise((r) => setTimeout(r, 2));
    expect(s.error.value).toBe("the provider did not answer");
    expect(s.matches.value).toEqual([]);
    fail = false;
    s.type("y");
    s.dispose();
    await new Promise((r) => setTimeout(r, 2));
    expect(s.matches.value).toEqual([]);
  });
});

describe("the entities", () => {
  test("load for the signed-in user and drop with them", async () => {
    answer = (url) =>
      Response.json(
        url.endsWith("/api/agents")
          ? { agents: [coder] }
          : { providers: [router] },
      );
    await Promise.all([loadProviders(), loadAgents()]);
    expect(providers.value).toEqual([router]);
    expect(agents.value).toEqual([coder]);
    me.value = null;
    expect(providers.value).toBeNull();
    expect(agents.value).toBeNull();
  });

  test("a write puts the server's row in the list", async () => {
    providers.value = [];
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json({})
        : Response.json({ provider: router });
    await createProvider({
      name: "router",
      wire: "openrouter",
      baseUrl: router.baseUrl,
      keyName: "router",
    });
    expect(providers.value).toEqual([router]);
    await deleteProvider("pr1");
    expect(providers.value).toEqual([]);
  });

  test("a refusal is the error shown, and the search asks the server", async () => {
    answer = () => Response.json({ error: "forbidden" }, { status: 403 });
    await loadProviders();
    expect(providersError.value).toBe("forbidden");
    let asked = "";
    answer = (url) => {
      asked = url;
      return Response.json({ matches: [flash] });
    };
    expect(await searchCatalog("pr1", "deep seek")).toEqual([flash]);
    expect(asked).toBe("/api/providers/pr1/catalog?q=deep%20seek");
  });
});

describe("the rail", () => {
  test("groups the admin routes under Admin, and hides them from a member", () => {
    const rows = railRows("admin");
    const group = rows.find((r) => r.kind === "group");
    expect(group?.kind === "group" && group.name).toBe("Admin");
    expect(group?.kind === "group" && group.routes.map((r) => r.path)).toEqual([
      "/admin/projects",
      "/admin/users",
      "/admin/agents",
      "/admin/tools",
    ]);
    expect(railRows("member").some((r) => r.kind === "group")).toBe(false);
  });
});

describe("the page", () => {
  test("renders the agents with their model and the providers with their key", () => {
    providers.value = [router];
    agents.value = [coder];
    const html = render(<Agents />);
    expect(html).toContain("coder");
    // the row names the model by its id, never the alias
    expect(html).toContain("deepseek/deepseek-v4-flash");
    expect(html).not.toContain("DeepSeek: V4 Flash");
    expect(html).toContain("router · 128k · $0.14 / $0.28 · tools · reasoning");
    expect(html).toContain("router.key missing");
    agents.value = [{ ...coder, thinking: "on", effort: "xhigh" }];
    expect(render(<Agents />)).toContain(
      "reasoning · thinking on · effort xhigh",
    );
    limits.value = [
      {
        name: "contextReserve",
        value: 20_000,
        default: 20_000,
        min: 1000,
        max: 200_000,
        unit: "tokens",
        scope: "send",
        changedAt: null,
      },
    ];
    // where the model compacts is the form's line, not the row's
    expect(render(<Agents />)).not.toContain("auto compaction");
    limits.value = null;
    expect(html).toContain("New agent");
    expect(html).toContain("New provider");
  });

  test("says what to do first when there is nothing", () => {
    providers.value = [];
    agents.value = [];
    const html = render(<Agents />);
    expect(html).toContain("Add a provider below");
    expect(html).toContain("No providers yet");
  });
});
