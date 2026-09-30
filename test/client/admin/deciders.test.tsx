// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { agents, agentsError } from "../../../src/client/data/agents.ts";
import {
  checkDecider,
  deciders,
  decidersError,
  deleteDecider,
  loadDeciders,
  loadDeciderUsage,
  updateDecider,
} from "../../../src/client/data/deciders.ts";
import { decisions } from "../../../src/client/data/decisions.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  providers,
  providersError,
  searchCatalog,
} from "../../../src/client/data/providers.ts";
import { DeciderList } from "../../../src/client/views/admin/DeciderLists.tsx";
import { DeciderDrafts } from "../../../src/client/views/admin/DeciderPage.state.ts";
import { DeciderPage } from "../../../src/client/views/admin/DeciderPage.tsx";
import {
  askedBy,
  checkCost,
  checkLine,
  deciderDeleteLine,
  deciderFieldOf,
  deciderMeta,
  deciderProviders,
  heldProvider,
  inputPriceLine,
  NO_DECIDERS,
} from "../../../src/client/views/admin/Deciders.model.ts";
import { NewDecider } from "../../../src/client/views/admin/NewDecider.tsx";
import type { DeciderSummary } from "../../../src/shared/contracts/decider.ts";
import type { DecisionSummary } from "../../../src/shared/contracts/decision.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../src/shared/contracts/provider.ts";
import { MAX_NAME } from "../../../src/shared/words.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import {
  admin as adminFixture,
  decider,
  provider,
} from "../../helpers/client-fixtures.ts";

const admin = adminFixture({ fullName: "Admin" });
const router = provider({ hasKey: true });
const local: ProviderSummary = {
  ...router,
  id: "pr2",
  name: "local",
  wire: "openai-compatible",
  baseUrl: "http://127.0.0.1:9000/v1",
  keyName: null,
};
const strict: ProviderSummary = {
  ...router,
  id: "pr3",
  name: "strict",
  wire: "openai-strict",
};
const gemini: ProviderSummary = {
  ...router,
  id: "pr4",
  name: "gemini",
  wire: "gemini",
};
const judge = decider();
const small: DeciderSummary = {
  id: "d2",
  name: "small",
  providerId: "pr2",
  model: "small-latest",
  contextLength: null,
  promptPrice: null,
  default: false,
  createdAt: 1,
};

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = admin;
  providers.value = null;
  providersError.value = null;
  agents.value = null;
  agentsError.value = null;
  deciders.value = null;
  decidersError.value = null;
});

describe("the words", () => {
  test.serial("a row's window and input price, only what is known", () => {
    expect(deciderMeta(judge)).toBe("32K · $0.04 input");
    expect(deciderMeta(small)).toBe("");
    expect(inputPriceLine(0)).toBe("free");
    expect(inputPriceLine(null)).toBe("");
  });

  test.serial("a check names its time, and its cost when there is one", () => {
    expect(
      checkLine({
        pick: true,
        probability: 0.99,
        ms: 345.4,
        cost: 0.000001,
        served: "vendor/judge-1-20260917",
      }),
    ).toBe("Answered in 345 ms for $0.000001");
    expect(
      checkLine({
        pick: true,
        probability: 0.99,
        ms: 85,
        cost: null,
        served: "small-latest",
      }),
    ).toBe("Answered in 85 ms");
    expect(
      checkLine({ pick: false, probability: 1, ms: 1234, cost: 0, served: "" }),
    ).toBe("Answered in 1,234 ms for $0");
    expect(checkCost(0.0000123)).toBe("$0.000012");
    expect(checkCost(0.5)).toBe("$0.5");
    expect(checkCost(1e-9)).toBe("$0.000000001");
  });

  test.serial("only the wires that answer decisions are offered", () => {
    expect(deciderProviders([router, local, strict, gemini])).toEqual([
      router,
      local,
    ]);
  });

  test.serial("maps field refusals, leaving other failures unassigned", () => {
    const cases = [
      ["name must be 2 to 32 lowercase letters, digits or dashes", "name"],
      ["a decider named judge exists", "name"],
      ["providerId must be an id", "provider"],
      ["no such provider", "provider"],
      ["router serves no decision models", "provider"],
      ["model must be a model id", "model"],
      ["router does not list vendor/x as a decision model", "model"],
      ["default must be true or false", undefined],
      ["no such decider", undefined],
      ["models did not answer in time", undefined],
      ["models answered 500", undefined],
      ["name-server did not answer in time", undefined],
      ["name-server answered 500", undefined],
    ] as const;
    for (const [words, field] of cases) {
      expect(deciderFieldOf(words), words).toBe(field);
    }
  });

  test.serial(
    "New decider holds an offered provider while there is one",
    () => {
      expect(heldProvider([router, local], "pr2")).toBe("pr2");
      // the picked one deleted meanwhile
      expect(heldProvider([router, local], "pr9")).toBe("pr1");
      expect(heldProvider([local], "")).toBe("pr2");
      expect(heldProvider([], "pr1")).toBe("");
    },
  );
});

describe("the entity", () => {
  test.serial("loads for the signed-in user and drops with them", async () => {
    answer = () => Response.json({ deciders: [judge, small] });
    await loadDeciders();
    expect(deciders.value).toEqual([judge, small]);
    me.value = null;
    expect(deciders.value).toBeNull();
  });

  test.serial(
    "a moved mark or a deleted default reloads the list",
    async () => {
      deciders.value = [judge, small];
      const asked: string[] = [];
      answer = (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/deciders") {
          return Response.json({ deciders: [{ ...small, default: true }] });
        }
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        return Response.json({ decider: { ...small, default: true } });
      };
      const body = { name: "small", providerId: "pr2", model: "small-latest" };
      await updateDecider("d2", body);
      expect(asked).toEqual(["PATCH /api/deciders/d2"]);
      await updateDecider("d2", { ...body, default: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(asked.slice(1)).toEqual([
        "PATCH /api/deciders/d2",
        "GET /api/deciders",
      ]);
      deciders.value = [judge, small];
      await deleteDecider("d1");
      await new Promise((r) => setTimeout(r, 0));
      expect(asked.slice(3)).toEqual([
        "DELETE /api/deciders/d1",
        "GET /api/deciders",
      ]);
      expect(deciders.value).toEqual([{ ...small, default: true }]);
    },
  );

  test.serial("a check and the decisions catalog are plain calls", async () => {
    const asked: string[] = [];
    answer = (url, init) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      return url.includes("/catalog")
        ? Response.json({ matches: [] })
        : Response.json({
            pick: true,
            probability: 1,
            ms: 85,
            cost: null,
            served: "small-latest",
          });
    };
    await searchCatalog("pr1", "jev", "decisions");
    await searchCatalog("pr1", "jev");
    expect((await checkDecider("d1")).ms).toBe(85);
    expect(asked).toEqual([
      "GET /api/providers/pr1/catalog?q=jev&kind=decisions",
      "GET /api/providers/pr1/catalog?q=jev",
      "POST /api/deciders/d1/check",
    ]);
  });
});

describe("the pages", () => {
  const page = (name: string) => render(<DeciderPage params={{ name }} />);
  const run: DecisionSummary = {
    id: "run-attention",
    enabled: true,
    deciderId: null,
    options: [],
  };

  test.serial("a row per decider: default, provider, window, price", () => {
    providers.value = [router, local];
    deciders.value = [judge, small];
    decisions.value = [];
    const html = render(<DeciderList />);
    expect(html).toContain('href="/admin/config/deciders/judge"');
    expect(html).toContain('<span class="tag">default</span>');
    expect(html).toContain("vendor/judge-1");
    expect(html).toContain(">router<");
    expect(html).toContain(">32K · $0.04 input<");
    // a local server's decider has no price or window to say
    expect(html).toContain(">local<");
    expect(html).toContain('href="/admin/config/deciders?new"');
    expect(html).not.toContain("No deciders yet");
    expect(html).toMatch(/aria-current="page"[^>]*>Deciders/);
  });

  test.serial("says what having none means, and what to add first", () => {
    providers.value = [router];
    deciders.value = [];
    decisions.value = [];
    expect(render(<DeciderList />)).toContain(NO_DECIDERS);
    // a provider that answers no decisions offers no New decider
    providers.value = [strict, gemini];
    const none = render(<DeciderList />);
    expect(none).toContain("Add an OpenRouter or OpenAI-compatible provider");
    expect(none).not.toContain("New decider");
  });

  test.serial("New decider searches the first provider that answers", () => {
    providers.value = [strict, router, gemini, local];
    deciders.value = [];
    const html = render(<NewDecider />);
    // by name, only the wires that answer decisions: local before router
    expect(html).toContain('class="model-picker-provider" title="local"');
    // the default decider's provider comes first
    deciders.value = [judge];
    expect(render(<NewDecider />)).toContain(
      'class="model-picker-provider" title="router"',
    );
    deciders.value = [];
    expect(html).toContain('name="model"');
    expect(html).toContain("Create decider");
    expect(html).not.toContain("Default decider");
    expect((html.match(/type="submit"/g) ?? []).length).toBe(1);
    providers.value = [strict, gemini];
    expect(render(<NewDecider />)).toContain("Add a provider");
  });

  test.serial("a decider's page: its cards, one form each", () => {
    providers.value = [router, local];
    deciders.value = [judge, small];
    decisions.value = [run];
    const html = page("small");
    expect(html).toContain(">Identity<");
    expect(html).toContain(">Model<");
    expect(html).toContain(">Check<");
    expect(html).toContain("Delete small");
    expect(html).toContain("small-latest");
    expect(html).toContain("local");
    // Identity and Model save, Check and Delete are buttons
    expect(html.split("<form").length).toBe(3);
    // nothing asks it, so Delete has nothing to say
    expect(html).toContain("Delete small</h2></div>");
    // the aside names the decisions that ask it: none, judge is default
    expect(html).toContain("No decision.");
  });

  test.serial("the default decider answers what names none", () => {
    providers.value = [router, local];
    deciders.value = [judge, small];
    decisions.value = [run];
    const html = page("judge");
    expect(html).toContain('href="/admin/config/decisions/run-attention"');
    expect(html).toContain("Its decisions go to the default decider.");
    // the oldest, while it is the default, keeps the mark
    expect(html).toContain("Mark another decider to move it");
    expect(html).toMatch(
      /<input type="checkbox"[^>]*name="default"[^>]*disabled/,
    );
    expect(page("small")).not.toContain("Mark another decider");
  });

  test.serial("an unknown name is a missing page", () => {
    providers.value = [router];
    deciders.value = [judge];
    decisions.value = [];
    expect(page("gone")).toContain("No decider by that name.");
  });

  test.serial("the aside has its last 30 days, kept per decider", async () => {
    // a sign-in change drops every answer
    me.value = null;
    me.value = admin;
    providers.value = [router];
    deciders.value = [judge, small];
    decisions.value = [];
    expect(page("judge")).toContain("Loading");
    answer = (url) =>
      url === "/api/deciders/d1/usage"
        ? Response.json({
            since: 0,
            until: 1,
            answers: 12,
            tokens: 3400,
            cost: 0.0002,
          })
        : new Response("no", { status: 500 });
    await loadDeciderUsage("d1");
    await loadDeciderUsage("d2");
    expect(page("judge")).toMatch(/Answers[\s\S]*?12/);
    expect(page("judge")).toContain('href="/admin/monitor/usage"');
    // another decider's failed read is not this one's
    expect(page("judge")).not.toContain("Did not load.");
    expect(page("small")).toContain("Did not load.");
  });

  test.serial("a name input stops at the longest name", () => {
    providers.value = [router];
    deciders.value = [judge];
    decisions.value = [];
    const limit = new RegExp(`name="name"[^>]*maxLength="${MAX_NAME}"`, "i");
    expect(page("judge")).toMatch(limit);
    expect(render(<NewDecider />)).toMatch(limit);
  });
});

describe("the Delete line", () => {
  test.serial("says where what it answers goes", () => {
    const one = { id: "d1", default: true };
    const other = { id: "d2", default: false };
    expect(deciderDeleteLine(one, [one], 0)).toBeUndefined();
    expect(deciderDeleteLine(other, [one, other], 0)).toBeUndefined();
    expect(deciderDeleteLine(one, [one], 1)).toBe(
      "Decisions stay off until another decider is added.",
    );
    expect(deciderDeleteLine(other, [one, other], 2)).toBe(
      "Its decisions go to the default decider.",
    );
  });

  test.serial(
    "a decider answers what names it, and while default what names none",
    () => {
      const named = { deciderId: "d2" };
      const none = { deciderId: null };
      expect(askedBy({ id: "d1", default: true }, [named, none])).toEqual([
        none,
      ]);
      expect(askedBy({ id: "d2", default: false }, [named, none])).toEqual([
        named,
      ]);
    },
  );
});

describe("a decider's drafts", () => {
  const kev: CatalogMatch = {
    id: "vendor/kev-4b",
    name: "Kev 4B",
    contextLength: 8192,
    promptPrice: 0.04,
    completionPrice: null,
    tools: false,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: true,
    described: true,
  };

  test.serial("Change, Cancel and a pick", () => {
    const d = DeciderDrafts.of(judge);
    expect(d.cancellable).toBe(false);
    d.change();
    expect(d.changing.value).toBe(true);
    expect(d.cancellable).toBe(true);
    // another provider's catalog: the model goes with the old one
    d.chooseProvider("pr2");
    expect(d.model.value).toBeNull();
    expect(d.modelDirty(judge)).toBe(true);
    d.cancel();
    expect(d.providerId.value).toBe("pr1");
    expect(d.model.value?.id).toBe("vendor/judge-1");
    expect(d.changing.value).toBe(false);
    d.change();
    d.pick(kev);
    expect(d.model.value).toEqual({
      id: "vendor/kev-4b",
      contextLength: 8192,
      promptPrice: kev.promptPrice,
    });
    expect(d.changing.value).toBe(false);
    expect(d.modelDirty(judge)).toBe(true);
    d.resetModel(judge);
    expect(d.modelDirty(judge)).toBe(false);
  });

  test.serial(
    "New decider opens on the search with nothing to take back",
    () => {
      const d = DeciderDrafts.blank("pr1");
      expect(d.changing.value).toBe(true);
      expect(d.cancellable).toBe(false);
    },
  );

  test.serial(
    "a row changed under the page carries what the admin left",
    () => {
      const d = DeciderDrafts.of(judge);
      d.name.value = "judge-2";
      d.follow(judge, { ...judge, name: "renamed", default: false });
      // the typed name stays, the untouched mark follows
      expect(d.name.value).toBe("judge-2");
      expect(d.isDefault.value).toBe(false);
      d.follow(judge, { ...judge, model: "vendor/other" });
      expect(d.model.value?.id).toBe("vendor/other");
    },
  );
});
