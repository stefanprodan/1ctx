// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Deciders card on the agents page: the words a row and a Check
// say, the providers a decider may run on, the entity that follows the
// signed-in user, and the card and its form rendered over the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { agents, agentsError } from "../../../src/client/data/agents.ts";
import {
  checkDecider,
  deciders,
  decidersError,
  deleteDecider,
  loadDeciders,
  updateDecider,
} from "../../../src/client/data/deciders.ts";
import { decisions } from "../../../src/client/data/decisions.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  providers,
  providersError,
  searchCatalog,
} from "../../../src/client/data/providers.ts";
import { sentence } from "../../../src/client/lib/format.ts";
import { noticeOf, Save } from "../../../src/client/lib/save.ts";
import { Agents } from "../../../src/client/views/admin/Agents.tsx";
import { DeciderForm } from "../../../src/client/views/admin/DeciderForm.tsx";
import {
  checkCost,
  checkLine,
  deciderFieldOf,
  deciderMeta,
  deciderProviders,
  heldProvider,
  inputPriceLine,
  NO_DECIDERS,
  providerProblem,
} from "../../../src/client/views/admin/Deciders.model.ts";
import { DecidersCard } from "../../../src/client/views/admin/DecidersCard.tsx";
import { DefaultField } from "../../../src/client/views/admin/DefaultField.tsx";
import type { DeciderSummary } from "../../../src/shared/contracts/decider.ts";
import type { ProviderSummary } from "../../../src/shared/contracts/provider.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Admin",
  role: "admin",
  mustChangePassword: false,
};
const router: ProviderSummary = {
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: "http://models.test/v1",
  keyName: "provider-router",
  hasKey: true,
  createdAt: 0,
};
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
const judge: DeciderSummary = {
  id: "d1",
  name: "judge",
  providerId: "pr1",
  model: "vendor/judge-1",
  contextLength: 32_000,
  promptPrice: 0.04,
  default: true,
  createdAt: 0,
};
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

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  me.value = admin;
  providers.value = null;
  providersError.value = null;
  agents.value = null;
  agentsError.value = null;
  deciders.value = null;
  decidersError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
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

  test.serial("a save's refusal lands on the field it names", () => {
    const cases: [string, string][] = [
      ["name must be 2 to 32 lowercase letters, digits or dashes", "name"],
      ["a decider named judge exists", "name"],
      ["providerId must be an id", "provider"],
      ["no such provider", "provider"],
      ["router serves no decision models", "provider"],
      ["model must be a model id", "model"],
      ["router does not list vendor/x as a decision model", "model"],
    ];
    for (const [words, field] of cases) {
      expect(deciderFieldOf(words)).toBe(field);
    }
    expect(deciderFieldOf("default must be true or false")).toBeUndefined();
    expect(deciderFieldOf("no such decider")).toBeUndefined();
  });

  test.serial("a Check's refusal stays in the foot", async () => {
    // a provider's name leads a Check's words and may look like a field
    const refusals = [
      "models did not answer in time",
      "models answered 500",
      "name-server did not answer in time",
      "name-server answered 500",
      "no such provider",
    ];
    for (const words of refusals.slice(0, 4)) {
      expect(deciderFieldOf(words)).toBeUndefined();
    }
    // a save's words, yet a Check's too: the Check path skips the fields
    for (const words of refusals) {
      const save = new Save(async () => {}, 5, deciderFieldOf);
      const ok = await save.act(
        "check",
        () => Promise.reject(new Error(words)),
        { whole: true },
      );
      expect(ok).toBe(false);
      expect(save.fieldError("name")).toBeNull();
      expect(save.fieldError("provider")).toBeNull();
      expect(save.fieldError("model")).toBeNull();
      expect(noticeOf(save.notice()!)).toBe(
        `Could not check. ${sentence(words)}`,
      );
    }
  });

  test.serial("the form holds an offered provider while there is one", () => {
    expect(heldProvider([router, local], "pr2")).toBe("pr2");
    // the picked one deleted on the same page
    expect(heldProvider([router, local], "pr9")).toBe("pr1");
    expect(heldProvider([local], "")).toBe("pr2");
    expect(heldProvider([], "pr1")).toBe("");
    expect(providerProblem([router], "pr1")).toBeNull();
    expect(providerProblem([], "")).toBe(
      "Add an OpenRouter or OpenAI-compatible provider first",
    );
    expect(providerProblem([router], "")).toBe("Pick a provider");
  });
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

describe("the card", () => {
  test.serial("a row per decider: default, provider, window, price", () => {
    deciders.value = [judge, small];
    const html = render(<DecidersCard providers={[router, local]} />);
    expect(html).toContain("judge");
    expect(html).toContain("vendor/judge-1");
    expect(html).toContain(">default · router · 32K · $0.04 input");
    expect(html).toContain(
      '<span class="rows-meta-short">default · 32K · $0.04 input</span>',
    );
    // a local server's decider has no price or window to say
    expect(html).toContain(">local<");
    expect(html).toContain("New decider");
    expect(html).not.toContain("No deciders yet");
  });

  test.serial("says what having none means", () => {
    deciders.value = [];
    const html = render(<DecidersCard providers={[router]} />);
    expect(html).toContain(NO_DECIDERS);
    expect(NO_DECIDERS).toBe(
      "No deciders yet. Decisions stay off until one is added.",
    );
  });

  test.serial("New decider is off without a provider that answers", () => {
    deciders.value = [];
    const off = render(<DecidersCard providers={[strict, gemini]} />);
    expect(off).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?New decider/);
    const on = render(<DecidersCard providers={[strict, router]} />);
    expect(on).not.toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?New decider/);
  });

  test.serial("sits after the providers and the agents", () => {
    providers.value = [router];
    agents.value = [];
    deciders.value = [];
    decisions.value = [];
    const html = render(<Agents />);
    const at = (label: string) => html.indexOf(`>${label}<`);
    expect(at("Providers")).toBeGreaterThan(-1);
    expect(at("New agent")).toBeGreaterThan(at("New provider"));
    expect(at("Deciders")).toBeGreaterThan(at("New agent"));
    expect(at("Decisions")).toBeGreaterThan(at("Deciders"));
  });

  test.serial("the form offers only the providers that answer", () => {
    deciders.value = [];
    const html = render(
      <DeciderForm
        decider={null}
        providers={[router, strict, local, gemini]}
        onDone={() => {}}
      />,
    );
    expect(html).toContain(">router<");
    expect(html).toContain(">local<");
    expect(html).not.toContain(">strict<");
    expect(html).not.toContain(">gemini<");
    expect(html).toContain("Default decider");
    expect(html).toContain("Add decider");
    // a new decider has nothing saved to check
    expect(html).not.toContain(">Check<");
    expect(html).not.toContain('role="status"');
  });

  test.serial("an open row checks and deletes", () => {
    deciders.value = [judge, small];
    const html = render(
      <DeciderForm decider={small} providers={[router]} onDone={() => {}} />,
    );
    expect(html).toContain(">Check<");
    expect(html).toContain(">Delete<");
    // mounted empty, so a screen reader announces what Check answers
    expect(html).toContain('<p class="agents-checked" role="status"></p>');
    expect(html).toContain("small-latest");
  });

  test.serial("the oldest, while it is the default, cannot say No", () => {
    deciders.value = [judge, small];
    const field = (row: DeciderSummary) =>
      render(
        <DefaultField
          row={row}
          on={signal(row.default)}
          save={{ busy: false, touch() {} }}
          oldest={deciders.value?.[0]?.id}
          label="Default decider"
        />,
      );
    expect(field(judge).match(/ disabled/g)).toHaveLength(2);
    expect(field(small)).not.toContain("disabled");
  });
});
