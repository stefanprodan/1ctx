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
  keys,
  loadProviders,
  providers,
  providersError,
  searchCatalog,
} from "../../../src/client/data/providers.ts";
import { limits } from "../../../src/client/data/tools.ts";
import { keyOptions } from "../../../src/client/lib/secrets.ts";
import { AgentForm } from "../../../src/client/views/admin/AgentForm.tsx";
import {
  agentFieldOf,
  compactLine,
  contextProblem,
  defaultThinking,
  effortApplies,
  effortChoices,
  keyLine,
  nameProblem,
  preset,
  priceLine,
  providerFieldOf,
  reserveOf,
  sentEffort,
  statedFields,
  statedModel,
  statedProblem,
  thinkingChoices,
  thinkingLine,
  windowLine,
} from "../../../src/client/views/admin/Agents.model.ts";
import { CatalogSearch } from "../../../src/client/views/admin/Agents.state.ts";
import { Agents } from "../../../src/client/views/admin/Agents.tsx";
import { ProviderForm } from "../../../src/client/views/admin/ProviderForm.tsx";
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
  keyName: "provider-router",
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
  described: true,
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
  skills: [],
  servers: [],
  mcpMode: "auto",
  createdAt: 0,
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  me.value = admin;
  providers.value = null;
  keys.value = [];
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
  test.serial("the model's own name, the org gone", () => {
    expect(shortModel("openrouter/free")).toBe("free");
    expect(shortModel("stefanprodan/Ornith-1.5-35B-A3B")).toBe(
      "Ornith-1.5-35B-A3B",
    );
    expect(shortModel("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  test.serial("window, price and key", () => {
    expect(windowLine(128000)).toBe("128k");
    expect(windowLine(1048576)).toBe("1M");
    expect(windowLine(null)).toBe("");
    expect(priceLine(0.14, 0.28)).toBe("$0.14 / $0.28");
    expect(priceLine(0, 0)).toBe("free");
    expect(priceLine(null, 1)).toBe("");
    expect(keyLine(null, false)).toBe("no key");
    expect(keyLine("provider-router", true)).toBe("provider-router.key");
    expect(keyLine("provider-router", false)).toBe(
      "provider-router.key missing",
    );
    expect(nameProblem("")).toBe("Enter a name");
    expect(nameProblem(" ")).toBe("Enter a name");
    expect(nameProblem("coder")).toBeNull();
    expect(preset("openrouter").baseUrl).toContain("/api/v1");
    expect(preset("openai-compatible").baseUrl).toBeNull();
    expect(preset("gemini").baseUrl).toContain("/v1beta");
    expect(preset("gemini").name).toBe("gemini");
    expect(preset("openai-compatible")).toMatchObject({
      label: "OpenAI-compatible",
      text: "mlx-serve, oMLX, llama-server, Ollama",
    });
    expect(preset("openai-strict")).toEqual({
      wire: "openai-strict",
      label: "OpenAI-strict",
      text: "GPT, Nvidia NIM, vLLM, Groq",
      baseUrl: null,
      name: "",
    });
    expect(
      providerFieldOf("keyName must be provider- followed by a name"),
    ).toBe("keyName");
  });

  test.serial(
    "the key picker keeps a missing selection and offers No key",
    () => {
      expect(keyOptions(["provider-router"], null)).toEqual([
        { value: "", label: "No key" },
        { value: "provider-router", label: "provider-router" },
      ]);
      expect(keyOptions(["provider-router"], "provider-gone")).toEqual([
        { value: "", label: "No key" },
        { value: "provider-router", label: "provider-router" },
        { value: "provider-gone", label: "provider-gone", detail: "missing" },
      ]);
      expect(keyOptions(["provider-router"], "provider-router")).toHaveLength(
        2,
      );
      expect(keyOptions([], null)).toEqual([{ value: "", label: "No key" }]);
    },
  );

  test.serial("thinking and effort: the default and the wire's levels", () => {
    expect(defaultThinking(flash)).toBe("on");
    expect(defaultThinking({ ...flash, reasoning: false })).toBe("off");
    expect(defaultThinking(null)).toBe("off");
    expect(thinkingChoices(flash)[0]).toEqual({
      value: null,
      label: "Default (on)",
    });
    // a catalog that lists only ids does not say whether the model thinks
    expect(
      thinkingChoices({ ...flash, reasoning: false, described: false })[0],
    ).toEqual({ value: null, label: "Default" });
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
    expect(effortChoices("gemini").map((c) => c.value)).toEqual([
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

  test.serial("where a model compacts, by the runner's formula", () => {
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

  test.serial("the effort sent follows the choices and the wire", () => {
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

describe("a model its catalog does not describe", () => {
  const ultra: CatalogMatch = {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "nvidia/nemotron-3-ultra-550b-a55b",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: false,
    reasoning: false,
    described: false,
  };

  test.serial(
    "the window is a whole number in range, required with tools",
    () => {
      expect(contextProblem("", false)).toBeNull();
      expect(contextProblem(" ", true)).toBe("Enter the context window");
      expect(contextProblem("262,144", true)).toBeNull();
      expect(contextProblem("262_144", true)).toBeNull();
      expect(contextProblem("1023", false)).toBe(
        "Enter a whole number from 1024 to 10000000",
      );
      expect(contextProblem("12.5k", false)).not.toBeNull();
      expect(statedProblem(flash, "", true)).toBeNull();
      expect(statedProblem(null, "", true)).toBeNull();
      expect(statedProblem(ultra, "", true)).toBe("Enter the context window");
      expect(
        agentFieldOf("contextLength is required for a model with tools"),
      ).toBe("contextLength");
    },
  );

  test.serial(
    "only an undescribed pick sends and shows what was stated",
    () => {
      expect(statedFields(flash, "4096", true)).toEqual({});
      expect(statedFields(null, "4096", true)).toEqual({});
      expect(statedFields(ultra, "262,144", true)).toEqual({
        contextLength: 262144,
        tools: true,
      });
      expect(statedFields(ultra, "", false)).toEqual({
        contextLength: null,
        tools: false,
      });
      expect(statedModel(flash, "4096", false)).toBe(flash);
      expect(statedModel(ultra, "262144", true)).toEqual({
        ...ultra,
        contextLength: 262144,
        tools: true,
      });
      // a window still being typed is no window yet
      expect(statedModel(ultra, "12", true)?.contextLength).toBeNull();
    },
  );

  test.serial("the form asks for them under the pick, and only then", () => {
    const nvidia: ProviderSummary = {
      ...router,
      id: "pr2",
      name: "nvidia",
      wire: "openai-strict",
    };
    const nim: AgentSummary = {
      ...coder,
      providerId: "pr2",
      model: { ...ultra, contextLength: 262144, tools: true },
    };
    const html = render(
      <AgentForm agent={nim} providers={[nvidia]} onDone={() => {}} />,
    );
    expect(html).toContain("Context window");
    expect(html).toMatch(/name="contextLength"[^>]*value="262144"/);
    expect(html).toContain("262k · tools");
    expect(html).toContain(">Default<");
    expect(html).not.toContain("Default (off)");
    const described = render(
      <AgentForm agent={coder} providers={[router]} onDone={() => {}} />,
    );
    expect(described).not.toContain("Context window");
  });
});

describe("CatalogSearch", () => {
  test.serial(
    "keeps only the latest answer and clears with the field",
    async () => {
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
    },
  );

  test.serial(
    "a failure is the answer, and nothing lands after dispose",
    async () => {
      let fail = true;
      const s = new CatalogSearch(async () => {
        if (fail) throw new Error("the provider did not answer");
        return [flash];
      }, 0);
      s.type("x");
      await new Promise((r) => setTimeout(r, 2));
      expect(s.error.value).toBe("The provider did not answer.");
      expect(s.matches.value).toEqual([]);
      fail = false;
      s.type("y");
      s.dispose();
      await new Promise((r) => setTimeout(r, 2));
      expect(s.matches.value).toEqual([]);
    },
  );
});

describe("the entities", () => {
  test.serial("load for the signed-in user and drop with them", async () => {
    answer = (url) =>
      Response.json(
        url.endsWith("/api/agents")
          ? { agents: [coder] }
          : { providers: [router], keys: ["provider-router"] },
      );
    await Promise.all([loadProviders(), loadAgents()]);
    expect(providers.value).toEqual([router]);
    expect(keys.value).toEqual(["provider-router"]);
    expect(agents.value).toEqual([coder]);
    me.value = null;
    expect(providers.value).toBeNull();
    expect(keys.value).toEqual([]);
    expect(agents.value).toBeNull();
  });

  test.serial(
    "provider rows and keys keep the latest load together",
    async () => {
      const pending: ((response: Response) => void)[] = [];
      answer = () => new Promise((resolve) => pending.push(resolve));
      const older = loadProviders();
      const newer = loadProviders();
      pending[1]!(
        Response.json({ providers: [router], keys: ["provider-new"] }),
      );
      await newer;
      pending[0]!(Response.json({ providers: [], keys: ["provider-old"] }));
      await older;
      expect(providers.value).toEqual([router]);
      expect(keys.value).toEqual(["provider-new"]);

      const departed = loadProviders();
      me.value = null;
      pending[2]!(
        Response.json({ providers: [router], keys: ["provider-old"] }),
      );
      await departed;
      expect(providers.value).toBeNull();
      expect(keys.value).toEqual([]);
    },
  );

  test.serial("a provider write supersedes a load in flight", async () => {
    keys.value = ["provider-router"];
    const gate = Promise.withResolvers<Response>();
    answer = () => gate.promise;
    const loading = loadProviders();
    answer = () => Response.json({ provider: router });
    await createProvider({
      name: router.name,
      wire: router.wire,
      baseUrl: router.baseUrl,
      keyName: router.keyName,
    });
    gate.resolve(Response.json({ providers: [], keys: ["provider-stale"] }));
    await loading;
    expect(providers.value).toEqual([router]);
    expect(keys.value).toEqual(["provider-router"]);
  });

  test.serial("a write puts the server's row in the list", async () => {
    providers.value = [];
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json({})
        : Response.json({ provider: router });
    await createProvider({
      name: "router",
      wire: "openrouter",
      baseUrl: router.baseUrl,
      keyName: "provider-router",
    });
    expect(providers.value).toEqual([router]);
    await deleteProvider("pr1");
    expect(providers.value).toEqual([]);
  });

  test.serial(
    "a refusal is the error shown, and the search asks the server",
    async () => {
      answer = () => Response.json({ error: "forbidden" }, { status: 403 });
      await loadProviders();
      expect(providersError.value).toEqual({ words: "forbidden", status: 403 });
      let asked = "";
      answer = (url) => {
        asked = url;
        return Response.json({ matches: [flash] });
      };
      expect(await searchCatalog("pr1", "deep seek")).toEqual([flash]);
      expect(asked).toBe("/api/providers/pr1/catalog?q=deep%20seek");
    },
  );
});

describe("the rail", () => {
  test.serial(
    "groups the admin routes under Admin, and hides them from a member",
    () => {
      const rows = railRows("admin");
      const group = rows.find((r) => r.kind === "group");
      expect(group?.kind === "group" && group.name).toBe("Admin");
      expect(
        group?.kind === "group" && group.routes.map((r) => r.path),
      ).toEqual([
        "/admin/projects",
        "/admin/users",
        "/admin/agents",
        "/admin/tools",
        "/admin/skills",
        "/admin/mcp",
      ]);
      expect(railRows("member").some((r) => r.kind === "group")).toBe(false);
    },
  );
});

describe("the page", () => {
  test.serial("the provider key field is a Select, not a text input", () => {
    keys.value = ["provider-router"];
    const html = render(<ProviderForm onDone={() => {}} />);
    expect(html).toMatch(/<button[^>]*name="keyName"/);
    expect(html).not.toMatch(/<input[^>]*name="keyName"/);
    expect(html).toContain("No key");
    expect(html).toContain("provider-&lt;name>.key");
  });

  test.serial(
    "renders the agents with their model and the providers with their key",
    () => {
      providers.value = [router];
      agents.value = [coder];
      const html = render(<Agents />);
      expect(html).toContain("coder");
      // the row names the model by its id, never the alias
      expect(html).toContain("deepseek/deepseek-v4-flash");
      expect(html).not.toContain("DeepSeek: V4 Flash");
      expect(html).toContain(
        "router · 128k · $0.14 / $0.28 · tools · reasoning",
      );
      expect(html).toContain("provider-router.key missing");
      // a phone shows the window and the price alone
      expect(html).toContain(
        '<span class="rows-meta-short">128k · $0.14 / $0.28</span>',
      );
      agents.value = [
        {
          ...coder,
          servers: [
            { serverId: "s1", read: true, write: false },
            { serverId: "s2", read: true, write: true },
          ],
        },
      ];
      expect(render(<Agents />)).toContain(
        "router · 128k · $0.14 / $0.28 · tools · reasoning · 2 MCPs",
      );
      agents.value = [
        { ...coder, servers: [{ serverId: "s1", read: true, write: false }] },
      ];
      expect(render(<Agents />)).toContain("reasoning · 1 MCP<");
      agents.value = [{ ...coder }];
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
    },
  );

  test.serial("says what to do first when there is nothing", () => {
    providers.value = [];
    agents.value = [];
    const html = render(<Agents />);
    expect(html).toContain("Add a provider below");
    expect(html).toContain("No providers yet");
  });
});
