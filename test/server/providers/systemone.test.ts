// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The decisions wire on the recorded answers: each type normalized to
// its pick and probability, a bad answer an error and never a guess,
// and an error in our words with the key scrubbed and the body unsaid.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DecisionError,
  type DecisionQuestion,
  type DecisionRequest,
  type ProviderRow,
  parseDecisions,
  refusedQuestion,
} from "../../../src/server/providers/index.ts";
import { requestDecisions } from "../../../src/server/providers/systemone.ts";
import { fakeFetch, KEV_URL, PROVIDER_URL } from "../../helpers/app.ts";

const recorded = (name: string) =>
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "fixtures",
        "providers",
        "systemone",
        name,
      ),
      "utf8",
    ),
  );

// the questions the recorder asked
const asked = (model: string): DecisionRequest => ({
  model,
  state: "A report.",
  questions: {
    outcome: {
      type: "choice",
      instructions: "What is the outcome?",
      criteria: { "all-good": "Fine.", "needs-attention": "A problem." },
    },
    severity: {
      type: "score",
      instructions: "How severe?",
      criteria: ["none", "minor", "major", "critical"],
    },
    act: { type: "noul", instructions: "Does it ask a person?" },
  },
});

const router: ProviderRow = {
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: PROVIDER_URL,
  keyName: "provider-router",
  createdAt: 0,
};

describe("parseDecisions", () => {
  test("normalizes each type of Jev's answer", () => {
    const parsed = parseDecisions(
      recorded("jev-answer.json"),
      asked("typesafe/jev-1.13"),
    );
    expect(parsed.served).toBe("typesafe/jev-1.13-20260917");
    expect(parsed.usage).toEqual({
      inputTokens: 441,
      outputTokens: 69,
      cost: 0.000018522,
    });
    expect(parsed.answers.outcome).toEqual({
      type: "choice",
      probabilities: { "all-good": 0, "needs-attention": 1 },
      pick: "needs-attention",
      probability: 1,
    });
    expect(parsed.answers.severity).toEqual({
      type: "score",
      probabilities: { none: 0, minor: 0, major: 0.68, critical: 0.32 },
      pick: "major",
      probability: 0.68,
    });
    expect(parsed.answers.act).toMatchObject({
      type: "noul",
      pick: false,
      probability: 0.89,
    });
    expect(parsed.answers.act!.probabilities.yes).toBe(0.11);
  });

  test("reads Kev-4B on OpenRouter and on a local server alike", () => {
    const remote = parseDecisions(
      recorded("kev-answer.json"),
      asked("jaredpalmer/kev-4b"),
    );
    const local = parseDecisions(
      recorded("kev-serve-answer.json"),
      asked("kev-latest"),
    );
    for (const parsed of [remote, local]) {
      expect(parsed.answers.outcome!.pick).toBe("needs-attention");
      expect(parsed.answers.outcome!.probability).toBeGreaterThan(0.9);
      expect(parsed.answers.severity!.pick).toBe("major");
    }
    // a local server names no cost
    expect(local.usage).toEqual({
      inputTokens: 128,
      outputTokens: 185,
      cost: null,
    });
    expect(local.served).toBe("kev-latest");
  });

  test("takes a yes/no alone from Respan, at no cost", () => {
    const parsed = parseDecisions(recorded("span-noul.json"), {
      model: "respan/span-01-lite:free",
      state: "A report.",
      questions: { act: { type: "noul", instructions: "Act?" } },
    });
    expect(parsed.answers.act).toMatchObject({ pick: false });
    expect(parsed.usage.cost).toBe(0);
  });

  test("names the model asked when the server does not", () => {
    const { model: _model, ...body } = recorded("jev-answer.json");
    expect(parseDecisions(body, asked("typesafe/jev-1.13")).served).toBe(
      "typesafe/jev-1.13",
    );
  });

  type Body = {
    answers: Record<
      string,
      { type?: string; noul?: number; probabilities?: Record<string, number> }
    >;
  };
  const bad: [string, (body: Body) => void, string][] = [
    ["a question missing", (b) => delete b.answers.act, "has no act"],
    [
      "a yes/no past 1",
      (b) => {
        b.answers.act!.noul = 1.2;
      },
      "act has no probability",
    ],
    [
      "a negative option",
      (b) => {
        b.answers.outcome!.probabilities!["all-good"] = -0.1;
      },
      "no probability for all-good",
    ],
    [
      "an option missing",
      (b) => delete b.answers.outcome!.probabilities!["all-good"],
      "no probability for all-good",
    ],
    [
      "a level missing",
      (b) => delete b.answers.severity!.probabilities!["3"],
      "no probability for critical",
    ],
    [
      "another type",
      (b) => {
        b.answers.act!.type = "choice";
      },
      "is not a noul",
    ],
    [
      "no probabilities",
      (b) => delete b.answers.outcome!.probabilities,
      "outcome has no probabilities",
    ],
  ];
  test.each(bad)("refuses %s", (_name, change, words) => {
    const body = recorded("jev-answer.json");
    change(body);
    expect(() => parseDecisions(body, asked("typesafe/jev-1.13"))).toThrow(
      words,
    );
    expect(() => parseDecisions(body, asked("typesafe/jev-1.13"))).toThrow(
      DecisionError,
    );
  });

  const one = (question: DecisionQuestion): DecisionRequest => ({
    model: "m",
    state: "A report.",
    questions: { q: question },
  });

  test("reads a score by name when its levels look like indices", () => {
    const req = one({
      type: "score",
      instructions: "How much?",
      criteria: ["1", "2", "3"],
    });
    const parsed = parseDecisions(
      { answers: { q: { probabilities: { "1": 0.1, "2": 0.2, "3": 0.7 } } } },
      req,
    );
    expect(parsed.answers.q).toMatchObject({
      probabilities: { "1": 0.1, "2": 0.2, "3": 0.7 },
      pick: "3",
      probability: 0.7,
    });
    // every index present reads by index
    const byIndex = parseDecisions(
      { answers: { q: { probabilities: { "0": 0.6, "1": 0.3, "2": 0.1 } } } },
      req,
    );
    expect(byIndex.answers.q).toMatchObject({ pick: "1", probability: 0.6 });
  });

  test("refuses probabilities that do not sum to 1", () => {
    const choice = one({
      type: "choice",
      instructions: "Which?",
      criteria: { a: null, b: null },
    });
    const score = one({
      type: "score",
      instructions: "How much?",
      criteria: ["low", "high"],
    });
    for (const [req, p] of [
      [choice, { a: 0.5, b: 0.6 }],
      [score, { "0": 0.2, "1": 0.2 }],
    ] as const) {
      expect(() =>
        parseDecisions({ answers: { q: { probabilities: p } } }, req),
      ).toThrow("do not sum to 1");
    }
    // a rounding stray is kept
    expect(
      parseDecisions(
        { answers: { q: { probabilities: { a: 0.495, b: 0.51 } } } },
        choice,
      ).answers.q!.pick,
    ).toBe("b");
  });

  test("a choice with no options is an error", () => {
    const req = one({ type: "choice", instructions: "Which?", criteria: {} });
    expect(() =>
      parseDecisions({ answers: { q: { probabilities: {} } } }, req),
    ).toThrow(DecisionError);
    expect(() =>
      parseDecisions({ answers: { q: { probabilities: {} } } }, req),
    ).toThrow("has no options");
  });

  test("keeps an id or option named __proto__", () => {
    const req: DecisionRequest = {
      model: "m",
      state: "A report.",
      questions: {
        ["__proto__"]: {
          type: "choice",
          instructions: "Which?",
          criteria: { ["__proto__"]: null, other: null },
        },
      },
    };
    const body = JSON.parse(
      '{"answers":{"__proto__":{"probabilities":{"__proto__":0.8,"other":0.2}}}}',
    );
    const parsed = parseDecisions(body, req);
    expect(Object.hasOwn(parsed.answers, "__proto__")).toBe(true);
    const answer = Object.getOwnPropertyDescriptor(parsed.answers, "__proto__")
      ?.value as { pick: string; probability: number };
    expect(answer.pick).toBe("__proto__");
    expect(answer.probability).toBe(0.8);
  });

  test("a choice the server names outside the options falls to the highest", () => {
    const body = recorded("kev-answer.json");
    body.answers.outcome.choice = "maybe";
    expect(
      parseDecisions(body, asked("jaredpalmer/kev-4b")).answers.outcome!.pick,
    ).toBe("needs-attention");
  });
});

describe("refusedQuestion", () => {
  test("finds the asked question a refusal names, and nothing else", () => {
    const text = JSON.stringify(recorded("span-refused-400.json"));
    expect(refusedQuestion(text, asked("x"))).toBe("outcome");
    expect(refusedQuestion('question "other" is bad', asked("x"))).toBeNull();
    expect(refusedQuestion("no question here", asked("x"))).toBeNull();
  });
});

describe("requestDecisions", () => {
  const deps = (fetcher: typeof fetch, key: string | null = "sk-router") => ({
    fetcher,
    secret: (name: string) => (name === "provider-router" ? key : null),
  });

  test("posts the body with the key and OpenRouter's headers", async () => {
    const fake = fakeFetch();
    const req: DecisionRequest = {
      model: "typesafe/jev-1.13",
      state: "A report.",
      questions: { check: { type: "noul", instructions: "A check?" } },
    };
    const parsed = await requestDecisions(
      router,
      deps(fake.fetcher),
      req,
      new AbortController().signal,
    );
    expect(parsed.answers.check).toMatchObject({ type: "noul", pick: false });
    expect(fake.calls[0]!.url).toBe(`${PROVIDER_URL}/systemone`);
    expect(fake.calls[0]!.headers).toMatchObject({
      authorization: "Bearer sk-router",
      "content-type": "application/json",
      "x-title": "1ctx",
    });
    expect(JSON.parse(fake.calls[0]!.body!)).toEqual(req);
  });

  test("sends no key and no OpenRouter header to a local server", async () => {
    const fake = fakeFetch();
    await requestDecisions(
      { ...router, wire: "openai-compatible", baseUrl: KEV_URL, keyName: null },
      deps(fake.fetcher),
      { ...asked("kev-latest") },
      new AbortController().signal,
    );
    expect(fake.calls[0]!.headers.authorization).toBeUndefined();
    expect(fake.calls[0]!.headers["x-title"]).toBeUndefined();
  });

  test("a refusal says the status and the question, never the body", async () => {
    const fake = fakeFetch();
    const err = await requestDecisions(
      router,
      deps(fake.fetcher),
      {
        ...asked("respan/span-01-lite:free"),
        model: "respan/span-01-lite:free",
      },
      new AbortController().signal,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.message).toBe("router answered 400 for question outcome");
  });

  test("scrubs the key the server echoes and keeps its body out", async () => {
    const fetcher = (async () =>
      new Response("bad key sk-router, state: secret words", {
        status: 401,
      })) as unknown as typeof fetch;
    const err = await requestDecisions(
      router,
      deps(fetcher),
      asked("m"),
      new AbortController().signal,
    ).catch((e) => e);
    expect(err.message).toBe("router answered 401");
    const thrown = (async () => {
      throw new TypeError("connect to sk-router failed");
    }) as unknown as typeof fetch;
    const down = await requestDecisions(
      router,
      deps(thrown),
      asked("m"),
      new AbortController().signal,
    ).catch((e) => e);
    expect(down.message).toBe("router did not answer: connect to [key] failed");
  });

  test("a missing key file, a timeout, no JSON and a huge body are errors", async () => {
    const fake = fakeFetch();
    await expect(
      requestDecisions(
        router,
        deps(fake.fetcher, null),
        asked("m"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("router has no key file provider-router.key");
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    await expect(
      requestDecisions(router, deps(hang), asked("m"), AbortSignal.timeout(5)),
    ).rejects.toThrow("router did not answer in time");
    const stop = new AbortController();
    const stopped = requestDecisions(
      router,
      deps(hang),
      asked("m"),
      stop.signal,
    );
    stop.abort();
    await expect(stopped).rejects.toThrow("the request to router was stopped");
    const text = (async () =>
      new Response("<html>")) as unknown as typeof fetch;
    await expect(
      requestDecisions(
        router,
        deps(text),
        asked("m"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("router did not answer with JSON");
    const huge = (async () =>
      new Response("x".repeat(2 * 1024 * 1024))) as unknown as typeof fetch;
    await expect(
      requestDecisions(
        router,
        deps(huge),
        asked("m"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("the answer is too large");
  });
});
