// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Decisions: the entity that follows the signed-in user, a
// row's meta, what a save sends and Reset fills, the checks and the
// fields a refusal names, and the list and a decision's page rendered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { deciders, decisionUsage } from "../../../src/client/data/deciders.ts";
import {
  decisions,
  decisionsError,
  loadDecisions,
  saveDecision,
} from "../../../src/client/data/decisions.ts";
import { me } from "../../../src/client/data/me.ts";
import { DecisionList } from "../../../src/client/views/admin/DeciderLists.tsx";
import { DecisionPage } from "../../../src/client/views/admin/DecisionPage.tsx";
import {
  DECISION_WORDS,
  deciderChoices,
  decisionBody,
  decisionFieldOf,
  decisionMeta,
  defaultTexts,
  differsFromDefault,
  heldDecider,
  isCustom,
  optionLabel,
  optionProblem,
} from "../../../src/client/views/admin/Decisions.model.ts";
import type { DeciderSummary } from "../../../src/shared/contracts/decider.ts";
import {
  DECISION_OPTIONS,
  DECISIONS,
  type DecisionSummary,
} from "../../../src/shared/contracts/decision.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Admin",
  role: "admin",
  mustChangePassword: false,
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
  ...judge,
  id: "d2",
  name: "small",
  model: "small-latest",
  default: false,
  createdAt: 1,
};

const options = DECISION_OPTIONS["run-attention"].map((o) => ({
  key: o.key,
  description: o.description,
  default: o.description,
}));
const plain: DecisionSummary = {
  id: "run-attention",
  enabled: true,
  deciderId: null,
  options,
};
const own: DecisionSummary = {
  ...plain,
  deciderId: "d2",
  options: [
    { ...options[0]!, description: "Live data, no errors" },
    options[1]!,
  ],
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  me.value = admin;
  deciders.value = null;
  decisions.value = null;
  decisionsError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the words", () => {
  test.serial("every decision and option has words", () => {
    for (const id of DECISIONS) {
      expect(DECISION_WORDS[id].title).not.toBe("");
      for (const o of DECISION_OPTIONS[id]) {
        expect(optionLabel(id, o.key)).not.toBe(o.key);
      }
    }
    expect(DECISION_WORDS["run-attention"].title).toBe(
      "Mark task runs that need attention",
    );
    expect(optionLabel("run-attention", "all-good")).toBe("All good when");
    expect(optionLabel("run-attention", "needs-attention")).toBe(
      "Needs attention when",
    );
  });

  test.serial("a row says off, who answers, and custom", () => {
    expect(decisionMeta(plain, [judge, small])).toEqual({
      long: "on · judge",
      short: "on · judge",
    });
    expect(decisionMeta(own, [judge, small])).toEqual({
      long: "on · small · custom",
      short: "on · small",
    });
    expect(decisionMeta({ ...own, enabled: false }, [judge])).toEqual({
      long: "off · custom",
      short: "off",
    });
    expect(decisionMeta(plain, [])).toEqual({
      long: "off until a decider is added",
      short: "off",
    });
    expect(isCustom(plain)).toBe(false);
    expect(isCustom(own)).toBe(true);
  });

  test.serial("the decider picks start with the default", () => {
    expect(deciderChoices([judge, small])).toEqual([
      { value: "", label: "Default (judge)" },
      { value: "d1", label: "judge" },
      { value: "d2", label: "small" },
    ]);
    expect(deciderChoices([])).toEqual([{ value: "", label: "Default" }]);
    expect(heldDecider([judge, small], "d2")).toBe("d2");
    // deleted on the same page
    expect(heldDecider([judge], "d2")).toBe("");
  });

  test.serial("a save sends every option trimmed", () => {
    expect(
      decisionBody(plain, {
        enabled: false,
        deciderId: "",
        texts: { "all-good": "  Fine  ", "needs-attention": "Broken\n" },
      }),
    ).toEqual({
      enabled: false,
      deciderId: null,
      options: { "all-good": "Fine", "needs-attention": "Broken" },
    });
    expect(
      decisionBody(plain, { enabled: true, deciderId: "d2", texts: {} }),
    ).toEqual({
      enabled: true,
      deciderId: "d2",
      options: { "all-good": "", "needs-attention": "" },
    });
  });

  test.serial("Reset fills the defaults, offered only when they differ", () => {
    const fill = defaultTexts(own);
    expect(fill).toEqual({
      "all-good": options[0]!.default,
      "needs-attention": options[1]!.default,
    });
    expect(differsFromDefault(own, fill)).toBe(false);
    expect(
      differsFromDefault(own, { ...fill, "all-good": "Live data, no errors" }),
    ).toBe(true);
    // a stray space is not a change
    expect(
      differsFromDefault(own, { ...fill, "all-good": ` ${fill["all-good"]} ` }),
    ).toBe(false);
  });

  test.serial("a description's check before a save", () => {
    expect(optionProblem("  ")).toBe("Say when this applies");
    expect(optionProblem("x".repeat(1001))).toBe("Keep it to 1,000 characters");
    expect(optionProblem(` ${"x".repeat(1000)} `)).toBeNull();
  });

  test.serial("a save's refusal lands on the field it names", () => {
    expect(
      decisionFieldOf("options.all-good must be 1 to 1000 characters"),
    ).toBe("options.all-good");
    expect(
      decisionFieldOf("options.needs-attention must be 1 to 1000 characters"),
    ).toBe("options.needs-attention");
    expect(decisionFieldOf("enabled must be true or false")).toBe("enabled");
    expect(decisionFieldOf("deciderId must be an id or null")).toBe("decider");
    expect(decisionFieldOf("no such decider")).toBe("decider");
    expect(decisionFieldOf("no such decision")).toBeUndefined();
    expect(decisionFieldOf("something else")).toBeUndefined();
  });
});

describe("the entity", () => {
  test.serial("loads for the signed-in user and drops with them", async () => {
    answer = () => Response.json({ decisions: [plain] });
    await loadDecisions();
    expect(decisions.value).toEqual([plain]);
    me.value = null;
    expect(decisions.value).toBeNull();
  });

  test.serial("a save puts the server's answer in the list", async () => {
    decisions.value = [plain];
    const asked: string[] = [];
    answer = (url, init) => {
      asked.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return Response.json({ decision: own });
    };
    const body = {
      enabled: true,
      deciderId: "d2",
      options: {
        "all-good": "Live data, no errors",
        "needs-attention": options[1]!.default,
      },
    };
    expect(await saveDecision("run-attention", body)).toEqual(own);
    expect(decisions.value).toEqual([own]);
    expect(asked).toEqual([
      `PUT /api/decisions/run-attention ${JSON.stringify(body)}`,
    ]);
  });

  test.serial("a load read before a save keeps the saved one", async () => {
    let release = () => {};
    answer = (_url, init) => {
      if (init?.method === "PUT") return Response.json({ decision: own });
      return new Promise((resolve) => {
        release = () => resolve(Response.json({ decisions: [plain] }));
      });
    };
    decisions.value = [plain];
    const loading = loadDecisions();
    await saveDecision("run-attention", {
      enabled: true,
      deciderId: "d2",
      options: {},
    });
    release();
    await loading;
    expect(decisions.value).toEqual([own]);
  });

  test.serial("a failed load is the page's", async () => {
    answer = () => Response.json({ error: "boom" }, { status: 500 });
    await loadDecisions();
    expect(decisionsError.value?.status).toBe(500);
    deciders.value = [];
    const html = render(<DecisionList />);
    expect(html).toContain("This page did not load");
    expect(html).toContain("Boom");
  });
});

describe("the pages", () => {
  const page = () => render(<DecisionPage params={{ id: "run-attention" }} />);

  test.serial("a row per decision with its meta, linking its page", () => {
    deciders.value = [judge, small];
    decisions.value = [own];
    const html = render(<DecisionList />);
    expect(html).not.toContain("rows-item-off");
    expect(html).toContain('aria-label="Decisions"');
    expect(html).toContain('placeholder="Search decisions"');
    expect(html).toContain('href="/config/decisions/run-attention"');
    expect(html).toContain("Mark task runs that need attention");
    expect(html).toContain(DECISION_WORDS["run-attention"].sub);
    expect(html).toContain(">on · small · custom");
    expect(html).toContain('<span class="rows-meta-short">on · small</span>');
    // the tabs lead to both lists, each counted
    expect(html).toContain('href="/config/deciders"');
    expect(html).toMatch(/aria-current="page"[^>]*>Decisions/);
  });

  test.serial("with no deciders the row stays, off until one is added", () => {
    deciders.value = [];
    decisions.value = [plain];
    const html = render(<DecisionList />);
    // an off decision's name goes faint
    expect(html).toContain('class="rows-item rows-item-off"');
    expect(html).toContain("Mark task runs that need attention");
    expect(html).toContain(">off until a decider is added");
  });

  test.serial(
    "the page: Status with the decider, Options with a box each",
    () => {
      deciders.value = [judge, small];
      decisions.value = [own];
      const html = page();
      // two cards, two forms, one submit each
      expect(html.split("<form").length).toBe(3);
      expect((html.match(/type="submit"/g) ?? []).length).toBe(2);
      expect(html).toContain(">On<");
      expect(html).toContain(">Off<");
      expect(html).toContain(DECISION_WORDS["run-attention"].hint);
      expect(html).toContain(">small<");
      // the select names who answers; no hint repeats it
      expect(html).not.toContain("Default follows");
      expect(html).toContain("All good when");
      expect(html).toContain("Needs attention when");
      expect(html).toContain('name="options.all-good"');
      expect(html).toContain('name="options.needs-attention"');
      expect(html).toContain("Live data, no errors");
      expect(html).toContain("Reset to default");
      // nothing changed yet, so each Save waits
      expect(html.match(/<button type="submit"[^>]*disabled/g)).toHaveLength(2);
      // the code's decision cannot go
      expect(html).not.toContain(">Delete<");
    },
  );

  test.serial("the defaults offer no Reset", () => {
    deciders.value = [judge];
    decisions.value = [plain];
    const html = page();
    expect(html).toContain("Default (judge)");
    expect(html).not.toContain("Reset to default");
  });

  test.serial("the page stays usable with no deciders", () => {
    deciders.value = [];
    decisions.value = [plain];
    const html = page();
    expect(html).toContain("Stays off until a decider is added.");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  test.serial("an unknown decision is a missing page", () => {
    deciders.value = [];
    decisions.value = [plain];
    expect(render(<DecisionPage params={{ id: "nope" }} />)).toContain(
      "No such decision.",
    );
  });

  test.serial("the aside has its last 30 days", () => {
    deciders.value = [judge];
    decisions.value = [plain];
    decisionUsage.value = null;
    expect(page()).toContain("Loading");
    decisionUsage.value = {
      of: "run-attention",
      usage: { since: 0, until: 1, answers: 7, tokens: 900, cost: null },
    };
    expect(page()).toMatch(/Answers[\s\S]*?7/);
    expect(page()).toContain("not priced");
    decisionUsage.value = null;
  });
});
