// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words the agents page shows, the search that keeps only the
// latest answer, the two entities that follow the signed-in user, the
// Admin group in the rail, and the page rendered over the rows.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import {
  priceLine,
  shortModel,
  thinkingLine,
  windowLine,
} from "../../../src/client/agents/meta.ts";
import {
  agents,
  agentsError,
  loadAgents,
  updateAgent,
} from "../../../src/client/data/agents.ts";
import { deciders } from "../../../src/client/data/deciders.ts";
import { decisions } from "../../../src/client/data/decisions.ts";
import { me } from "../../../src/client/data/me.ts";
import { overview, overviewError } from "../../../src/client/data/overview.ts";
import {
  createProvider,
  deleteProvider,
  keys,
  loadProviders,
  loadProviderUsage,
  providers,
  providersError,
  searchCatalog,
} from "../../../src/client/data/providers.ts";
import { keyOptions } from "../../../src/client/lib/secrets.ts";
import { AgentList } from "../../../src/client/views/admin/AgentList.tsx";
import { AgentModel } from "../../../src/client/views/admin/AgentModel.tsx";
import { AgentDrafts } from "../../../src/client/views/admin/AgentPage.state.ts";
import {
  ALL_FOUR_BIT,
  agentFieldOf,
  contextProblem,
  defaultThinking,
  effortApplies,
  effortChoices,
  fourBitEndpoint,
  PREFERRED_FOUR_BIT,
  SKIPPED,
  sentEffort,
  skip4BitLock,
  statedFields,
  statedModel,
  statedProblem,
  thinkingChoices,
  upstreamOptions,
} from "../../../src/client/views/admin/Agents.model.ts";
import { CatalogSearch } from "../../../src/client/views/admin/Agents.state.ts";
import { NewProvider } from "../../../src/client/views/admin/NewProvider.tsx";
import { ProviderPage } from "../../../src/client/views/admin/ProviderPage.tsx";
import {
  keyLine,
  preset,
  presetBaseUrl,
  providerDeleteLine,
  providerFieldOf,
} from "../../../src/client/views/admin/Providers.model.ts";
import { Providers } from "../../../src/client/views/admin/Providers.tsx";
import { Skip4BitField } from "../../../src/client/views/admin/UpstreamField.tsx";
import { parseEndpoints } from "../../../src/server/providers/index.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  CatalogMatch,
  Endpoint,
  ProviderSummary,
} from "../../../src/shared/contracts/provider.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import {
  admin as adminFixture,
  decider,
  provider,
} from "../../helpers/client-fixtures.ts";

const admin = adminFixture();
const router = provider();
const flash: CatalogMatch = {
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek: V4 Flash",
  contextLength: 128000,
  outputLimit: null,
  promptPrice: 0.14,
  completionPrice: 0.28,
  tools: true,
  reasoning: true,
  thinkingRequired: false,
  reasoningKnown: true,
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
  upstream: null,
  skip4Bit: false,
  default: false,
  createdAt: 0,
};

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = admin;
  providers.value = null;
  keys.value = [];
  providersError.value = null;
  agents.value = null;
  agentsError.value = null;
  // the page waits for the deciders and the decisions too; their cards
  // have their own suites
  deciders.value = [];
  decisions.value = [];
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
    expect(windowLine(128000)).toBe("128K");
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
      fixed: false,
      hint: null,
      name: "",
    });
    // OpenRouter's address is filled in and may move to the EU one
    expect(preset("openrouter")).toMatchObject({ fixed: false });
    expect(preset("openrouter").hint).toContain("keeps requests in the EU");
    expect(preset("gemini").fixed).toBe(true);
    // a preset's own address follows the preset, a typed one stays
    const openrouter = preset("openrouter").baseUrl!;
    expect(presetBaseUrl("", "openrouter")).toBe(openrouter);
    expect(presetBaseUrl(openrouter, "openai-strict")).toBe("");
    // the EU address opens the hint
    const eu = preset("openrouter").hint!.split(" ")[0]!;
    expect(presetBaseUrl(eu, "openai-strict")).toBe("");
    expect(presetBaseUrl("http://127.0.0.1:1234/v1", "openrouter")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(
      providerFieldOf("keyName must be provider- followed by a name"),
    ).toBe("keyName");
  });

  test.serial(
    "the key picker keeps a missing selection and offers No key",
    () => {
      expect(keyOptions(["provider-router"], "")).toEqual([
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
      expect(keyOptions([], "")).toEqual([{ value: "", label: "No key" }]);
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
      thinkingChoices({
        ...flash,
        reasoning: false,
        described: false,
        reasoningKnown: false,
      })[0],
    ).toEqual({ value: null, label: "Default" });
    expect(
      thinkingChoices({ ...flash, thinkingRequired: true }).map((c) => c.value),
    ).toEqual([null]);
    expect(thinkingChoices({ ...flash, reasoning: false })).toEqual([
      { value: null, label: "Off" },
    ]);
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
    expect(
      effortApplies(
        {
          ...flash,
          reasoning: false,
          described: false,
          reasoningKnown: false,
        },
        "on",
      ),
    ).toBe(true);
    // a model that never thinks takes no effort whatever the row says
    expect(effortApplies({ ...flash, reasoning: false }, "on")).toBe(false);
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
    outputLimit: null,
    promptPrice: null,
    completionPrice: null,
    tools: false,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: false,
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
        "Enter a whole number from 1,024 to 10,000,000",
      );
      expect(contextProblem("12.5k", false)).not.toBeNull();
      expect(statedProblem(flash, "", true)).toBeNull();
      expect(statedProblem(null, "", true)).toBeNull();
      expect(statedProblem(ultra, "", true)).toBe("Enter the context window");
      expect(
        agentFieldOf("contextLength is required for a model with tools"),
      ).toBe("contextLength");
      expect(agentFieldOf("upstream modelx does not serve m on router")).toBe(
        "upstream",
      );
    },
  );

  test.serial(
    "Preferred provider lists any provider first and leaves out what cannot serve tools",
    () => {
      const endpoint = {
        tag: "inference-net/fp4",
        name: "InferenceNet",
        quantization: "fp4",
        promptPrice: 0.045,
        completionPrice: 0.14,
        discount: 0.5,
        tools: true,
        reasoning: true,
      };
      const endpoints = [
        endpoint,
        { ...endpoint, tag: "sail/us", name: "Sail", quantization: "fp8" },
        { ...endpoint, tag: "sail/fp8", name: "Sail", quantization: "fp8" },
        {
          ...endpoint,
          tag: "relace",
          name: "Relace",
          quantization: null,
          discount: 0,
          tools: false,
        },
      ];
      expect(upstreamOptions(endpoints, true, null)).toEqual([
        { value: "", label: "Any provider", detail: "OpenRouter picks" },
        {
          value: "inference-net/fp4",
          label: "InferenceNet fp4",
          detail: "$0.045 / $0.14 · 50% off",
          keywords: "inference-net/fp4",
        },
        // two with one name are told apart by their tags
        {
          value: "sail/us",
          label: "sail/us",
          detail: "$0.045 / $0.14 · 50% off",
          keywords: "sail/us",
        },
        {
          value: "sail/fp8",
          label: "sail/fp8",
          detail: "$0.045 / $0.14 · 50% off",
          keywords: "sail/fp8",
        },
      ]);
      expect(upstreamOptions(endpoints, false, null).at(-1)).toEqual({
        value: "relace",
        label: "Relace",
        detail: "$0.045 / $0.14",
        keywords: "relace",
      });
      // a saved tag no longer listed stays a choice
      expect(upstreamOptions([], true, "gone").at(-1)).toEqual({
        value: "gone",
        label: "gone",
        detail: "not listed now",
      });
      // a list that did not load says nothing of it
      expect(upstreamOptions(null, true, "kept")).toEqual([
        { value: "", label: "Any provider", detail: "OpenRouter picks" },
        { value: "kept", label: "kept" },
      ]);
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
    providers.value = [nvidia];
    const html = render(
      <AgentModel agent={nim} drafts={AgentDrafts.of(nim)} />,
    );
    expect(html).toContain("Context window");
    expect(html).toMatch(/name="contextLength"[^>]*value="262144"/);
    expect(html).toContain("262K · tools");
    expect(html).toContain(">Default<");
    expect(html).not.toContain("Default (off)");
    providers.value = [router];
    const described = render(
      <AgentModel agent={coder} drafts={AgentDrafts.of(coder)} />,
    );
    expect(described).not.toContain("Context window");
    providers.value = null;
  });
});

describe("Skip 4-bit providers", () => {
  // the recorded answer: two fp4 hosts, one fp8 and two that do not say
  const recorded: Endpoint[] = parseEndpoints(
    JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "fixtures",
          "providers",
          "openrouter",
          "endpoints.json",
        ),
        "utf8",
      ),
    ),
  );

  test("a 4-bit host is its precision, else its tag", () => {
    const byTag = (tag: string) => recorded.find((e) => e.tag === tag)!;
    expect(fourBitEndpoint(byTag("inference-net/fp4"))).toBe(true);
    expect(fourBitEndpoint(byTag("baseten/fp8"))).toBe(false);
    expect(fourBitEndpoint(byTag("relace"))).toBe(false);
    expect(fourBitEndpoint({ ...byTag("relace"), tag: "relace/NVFP4" })).toBe(
      true,
    );
  });

  test("with the filter on, 4-bit options stay listed and cannot be picked", () => {
    const on = upstreamOptions(recorded, true, null, true);
    const off = upstreamOptions(recorded, true, null);
    expect(on.map((o) => o.value)).toEqual(off.map((o) => o.value));
    const locked = on.filter((o) => o.disabled);
    expect(locked.map((o) => o.value)).toEqual([
      "inference-net/fp4",
      "deepinfra/fp4",
    ]);
    for (const o of locked) expect(o.title).toBe(SKIPPED);
    expect(SKIPPED).toBe("Skipped by Skip 4-bit providers");
    expect(off.some((o) => o.disabled || o.title)).toBe(false);
  });

  test("the switch cannot be turned on where the filter could not serve", () => {
    expect(skip4BitLock(recorded, true, null)).toBeNull();
    expect(skip4BitLock(recorded, true, "baseten/fp8")).toBeNull();
    expect(skip4BitLock(recorded, true, "deepinfra/fp4")).toBe(
      "The preferred provider is 4-bit",
    );
    // a list that failed judges the tag
    expect(skip4BitLock(null, true, "deepinfra/fp4")).toBe(PREFERRED_FOUR_BIT);
    expect(skip4BitLock(null, true, "baseten")).toBeNull();
    const fourBit = recorded.filter(fourBitEndpoint);
    expect(skip4BitLock(fourBit, true, null)).toBe(
      "Every provider of this model is 4-bit",
    );
    // a host without tools never serves a model that takes them
    const noTools = recorded.map((e) =>
      fourBitEndpoint(e) ? e : { ...e, tools: false },
    );
    expect(skip4BitLock(noTools, true, null)).toBe(ALL_FOUR_BIT);
    expect(skip4BitLock(noTools, false, null)).toBeNull();
    expect(skip4BitLock([], true, null)).toBeNull();
  });

  test("a locked switch is disabled with its reason, and one on may go off", () => {
    const save = { fieldError: () => null };
    const locked = render(
      <Skip4BitField
        on={false}
        lock={ALL_FOUR_BIT}
        busy={false}
        save={save}
        onChange={() => {}}
      />,
    );
    expect(locked).toContain("Skip 4-bit providers");
    expect(locked).toMatch(
      /role="switch"[^>]*disabled[^>]*title="Every provider of this model is 4-bit"/,
    );
    const on = render(
      <Skip4BitField
        on
        lock={PREFERRED_FOUR_BIT}
        busy={false}
        save={save}
        onChange={() => {}}
      />,
    );
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain("disabled");
    expect(on).not.toContain("title=");
    const refused = render(
      <Skip4BitField
        on
        lock={null}
        busy={false}
        save={{
          fieldError: (f: string) =>
            f === "skip4Bit"
              ? "skip4Bit is only for an OpenRouter provider"
              : null,
        }}
        onChange={() => {}}
      />,
    );
    expect(refused).toContain('name="skip4Bit"');
    expect(refused).toContain('class="field-error"');
    expect(agentFieldOf("skip4Bit is only for an OpenRouter provider")).toBe(
      "skip4Bit",
    );
  });

  test.serial("the switch shows only on an OpenRouter provider", () => {
    providers.value = [router];
    const html = render(
      <AgentModel agent={coder} drafts={AgentDrafts.of(coder)} />,
    );
    expect(html).toContain("Preferred provider");
    expect(html).toContain("Skip 4-bit providers");
    providers.value = [{ ...router, wire: "openai-compatible" }];
    const plain = render(
      <AgentModel agent={coder} drafts={AgentDrafts.of(coder)} />,
    );
    expect(plain).not.toContain("Preferred provider");
    expect(plain).not.toContain("Skip 4-bit providers");
    providers.value = null;
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

describe("the default agent", () => {
  const ops: AgentSummary = { ...coder, id: "ag2", name: "ops", createdAt: 1 };

  test.serial("the row says default", () => {
    providers.value = [router];
    agents.value = [{ ...coder, default: true }];
    const html = render(<AgentList />);
    expect(html).toContain('<span class="tag">default</span>');
    expect(html).toContain('href="/admin/config/agents/coder"');
  });

  test.serial("a moved mark reloads the list", async () => {
    agents.value = [{ ...coder, default: true }, ops];
    const asked: string[] = [];
    answer = (url, init) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      return url === "/api/agents"
        ? Response.json({
            agents: [coder, { ...ops, default: true }],
            activity: [],
          })
        : Response.json({ agent: { ...ops, default: true } });
    };
    const body = {
      name: "ops",
      avatar: "bot" as const,
      providerId: "pr1",
      model: flash.id,
      thinking: null,
      effort: null,
      prompt: "",
      skills: [],
      servers: [],
      mcpMode: "auto" as const,
    };
    await updateAgent("ag2", body);
    expect(asked).toEqual(["PATCH /api/agents/ag2"]);
    await updateAgent("ag2", { ...body, default: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.slice(1)).toEqual([
      "PATCH /api/agents/ag2",
      "GET /api/agents",
    ]);
    expect(agents.value?.map((a) => a.default)).toEqual([false, true]);
  });
});

describe("the page", () => {
  test.serial("the provider key field is a Select, not a text input", () => {
    keys.value = ["provider-router"];
    providers.value = [];
    const html = render(<NewProvider />);
    expect(html).toContain("Create provider");
    expect(html).toContain('href="/admin/config/providers"');
    expect(html).toMatch(/<button[^>]*name="keyName"/);
    expect(html).not.toMatch(/<input[^>]*name="keyName"/);
    expect(html).toContain("No key");
    expect(html).toContain("provider-&lt;name>.key");
  });

  test.serial(
    "lists the agents by model and the providers with their key",
    () => {
      providers.value = [router];
      agents.value = [coder];
      const html = render(<AgentList />);
      expect(html).toContain("@coder");
      // the row names the model by its id, never the alias
      expect(html).toContain("deepseek/deepseek-v4-flash");
      expect(html).not.toContain("DeepSeek: V4 Flash");
      expect(html).toContain("never ran");
      expect(html).toContain("New agent");
      const page = render(<Providers />);
      expect(page).toContain("provider-router.key missing");
      expect(page).toContain('href="/admin/config/providers/router"');
      expect(page).toContain("1 agent");
      expect(page).toContain('href="/admin/config/providers?new"');
      expect(page).not.toContain("New agent");
    },
  );

  test.serial("the list's aside names each key file's provider", () => {
    providers.value = [router];
    agents.value = [];
    keys.value = ["provider-spare", "provider-router"];
    const html = render(<Providers />);
    expect(html).toMatch(
      /provider-router\.key<a\b[^>]*href="\/admin\/config\/providers\/router"[^>]*>router</,
    );
    expect(html).toMatch(/provider-spare\.key<span\b[^>]*>unused</);
    // by name, whatever order the server answered
    expect(html.indexOf("provider-router.key")).toBeLessThan(
      html.indexOf("provider-spare.key"),
    );
    keys.value = [];
    expect(render(<Providers />)).toContain("None in the secrets directory.");
  });

  test.serial("says what to do first when there is nothing", () => {
    providers.value = [];
    agents.value = [];
    expect(render(<AgentList />)).toContain("Add a provider first");
    expect(render(<Providers />)).toContain("No providers yet");
  });
});

describe("a provider's page", () => {
  const judge = decider();

  test.serial("says what it connects to and what runs on it", () => {
    providers.value = [router];
    agents.value = [coder];
    deciders.value = [judge];
    const html = render(<ProviderPage params={{ name: "router" }} />);
    expect(html).toContain("OpenRouter");
    expect(html).toContain("http://models.test/v1");
    expect(html).toContain("provider-router.key missing");
    expect(html).toContain('href="/admin/config/agents/coder"');
    expect(html).toContain('href="/admin/config/deciders/judge"');
    expect(html).toContain(
      "1 agent and 1 decider run on it. Move them to another provider first.",
    );
    // the server refuses a provider in use, so Delete waits
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete</);
  });

  test.serial("deletes a provider nothing runs on", () => {
    providers.value = [router];
    agents.value = [];
    deciders.value = [];
    const html = render(<ProviderPage params={{ name: "router" }} />);
    expect(html).toContain("No agent or decider runs on it yet.");
    expect(html).toContain(
      'href="/admin/config/agents?new&amp;provider=router"',
    );
    expect(html).toContain("Nothing runs on it.");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Delete</);
  });

  test.serial(
    "the aside has its last 30 days, or says it did not load",
    async () => {
      me.value = null;
      me.value = admin;
      providers.value = [router];
      agents.value = [];
      deciders.value = [];
      const page = () => render(<ProviderPage params={{ name: "router" }} />);
      expect(page()).toContain('split-empty">Loading');
      let asked = "";
      answer = (url) => {
        asked = url;
        return Response.json({
          since: 0,
          until: 1,
          sends: 12,
          tokens: 3400,
          cost: null,
        });
      };
      await loadProviderUsage("pr1");
      expect(asked).toBe("/api/providers/pr1/usage");
      expect(page()).toMatch(/Turns[\s\S]*?12/);
      expect(page()).toContain("not priced");
      expect(page()).toContain('href="/admin/monitor/usage"');
      // another provider's failed read is not this one's
      answer = () => Response.json({ error: "boom" }, { status: 500 });
      await loadProviderUsage("pr2");
      expect(page()).not.toContain("Did not load.");
      await loadProviderUsage("pr1");
      expect(page()).toContain("Did not load.");
    },
  );

  test.serial("waits for the deciders, which Used by and Delete name", () => {
    providers.value = [router];
    agents.value = [];
    deciders.value = null;
    const html = render(<ProviderPage params={{ name: "router" }} />);
    expect(html).not.toContain("Used by");
    expect(html).not.toContain("Nothing runs on it.");
    deciders.value = [];
  });

  test.serial(
    "the list's aside says when the last 30 days did not load",
    () => {
      providers.value = [router];
      agents.value = [];
      overview.value = null;
      overviewError.value = { words: "boom", status: 500 };
      expect(render(<Providers />)).toContain("Did not load.");
      overviewError.value = null;
      expect(render(<Providers />)).toContain("Loading");
    },
  );

  test.serial("an unknown name is a missing page", () => {
    providers.value = [router];
    agents.value = [];
    expect(render(<ProviderPage params={{ name: "gone" }} />)).toContain(
      "No provider by that name.",
    );
  });

  test.serial("the Delete line counts what keeps it", () => {
    expect(providerDeleteLine(0, 0)).toBe("Nothing runs on it.");
    expect(providerDeleteLine(2, 0)).toBe(
      "2 agents run on it. Move them to another provider first.",
    );
    expect(providerDeleteLine(0, 1)).toBe(
      "1 decider runs on it. Move it to another provider first.",
    );
  });
});
