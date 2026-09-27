// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// decide(): the default decider asked, one usage row per answer, a
// refused one included, none for a refusal, a timeout or a stop, and
// nothing asked with no decider.

import { describe, expect, test } from "bun:test";
import {
  ask,
  type ProvidersPort,
} from "../../../src/server/deciders/decide.ts";
import {
  DecisionError,
  type DecisionQuestion,
} from "../../../src/server/deciders/index.ts";
import { requestDecisions } from "../../../src/server/providers/systemone.ts";
import { fakeFetch, PROVIDER_URL, testApp } from "../../helpers/app.ts";

const OUTCOME: Record<string, DecisionQuestion> = {
  outcome: {
    type: "choice",
    instructions: "What is the outcome of this task run?",
    criteria: {
      "all-good": "Everything is fine.",
      "needs-attention": "A person should look.",
    },
  },
};

const use = {
  purpose: "run-attention" as const,
  sessionId: "s1",
  projectId: "p1",
};

async function withDecider(model: string | null, fetcher?: typeof fetch) {
  const app = await testApp({
    secrets: { "provider-router": "sk-router" },
    fetcher,
  });
  const provider = app.providers.create({
    name: "router",
    wire: "openrouter",
    baseUrl: PROVIDER_URL,
    keyName: "provider-router",
    now: app.now.value,
  });
  if (model !== null) {
    app.deciders.store.create({
      name: "judge",
      providerId: provider.id,
      model,
      contextLength: 32000,
      promptPrice: 0.04,
      now: app.now.value,
    });
  }
  return app;
}

const rows = (app: Awaited<ReturnType<typeof testApp>>) =>
  app.db.query("select * from decision_usage").all();

describe("decide", () => {
  test("with no decider asks nothing and answers null", async () => {
    const app = await withDecider(null);
    expect(
      await app.deciders.decide(
        use,
        OUTCOME,
        "A report.",
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(app.fetched).toHaveLength(0);
  });

  test("asks the default with the state cut to its window and counts it", async () => {
    const app = await withDecider("typesafe/jev-1.13");
    const windows: (number | null)[] = [];
    const decided = await app.deciders.decide(
      use,
      OUTCOME,
      (window) => {
        windows.push(window);
        return "A cut report.";
      },
      new AbortController().signal,
    );
    expect(windows).toEqual([32000]);
    expect(JSON.parse(app.fetched[0]!.body!).state).toBe("A cut report.");
    expect(decided).toMatchObject({
      decider: { name: "judge", contextLength: 32000 },
      served: "typesafe/jev-1.13-20260917",
      answers: {
        outcome: {
          type: "choice",
          pick: "needs-attention",
          probability: 1,
        },
      },
      usage: { inputTokens: 441, outputTokens: 69, cost: 0.000018522 },
    });
    expect(rows(app)).toEqual([
      {
        id: expect.any(String),
        decider_id: decided!.decider.id,
        decider_name: "judge",
        provider_id: expect.any(String),
        provider_name: "router",
        model: "typesafe/jev-1.13-20260917",
        purpose: "run-attention",
        session_id: "s1",
        project_id: "p1",
        input_tokens: 441,
        output_tokens: 69,
        cost: 0.000018522,
        duration: 0,
        created_at: app.now.value,
      },
    ]);
    // the row outlives its decider
    app.deciders.store.delete(decided!.decider.id);
    expect(rows(app)).toHaveLength(1);
  });

  test("a refusal throws in our words and writes no row", async () => {
    const app = await withDecider("respan/span-01-lite:free");
    const err = await app.deciders
      .decide(use, OUTCOME, "A report.", new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.message).toBe("router answered 400 for question outcome");
    expect(rows(app)).toHaveLength(0);
  });

  test("a stop by the caller throws and writes no row", async () => {
    const fake = fakeFetch();
    const hang = ((url: string, init: RequestInit) =>
      url.endsWith("/systemone")
        ? new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
          })
        : fake.fetcher(url, init)) as unknown as typeof fetch;
    const app = await withDecider("typesafe/jev-1.13", hang);
    const stop = new AbortController();
    const asked = app.deciders.decide(use, OUTCOME, "A report.", stop.signal);
    stop.abort();
    await expect(asked).rejects.toThrow("the request to router was stopped");
    expect(rows(app)).toHaveLength(0);
  });

  test("an answer refused as malformed throws and is still counted", async () => {
    const fake = fakeFetch();
    const skewed = (async (url: string, init: RequestInit) => {
      const res = await fake.fetcher(url, init);
      if (!url.endsWith("/systemone")) return res;
      const body = await res.json();
      body.answers.outcome.probabilities = {
        "all-good": 0.5,
        "needs-attention": 0.9,
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const app = await withDecider("typesafe/jev-1.13", skewed);
    const err = await app.deciders
      .decide(use, OUTCOME, "A report.", new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.message).toBe("the probabilities for outcome do not sum to 1");
    expect(rows(app)).toMatchObject([
      {
        model: "typesafe/jev-1.13-20260917",
        input_tokens: 441,
        output_tokens: 69,
        cost: 0.000018522,
      },
    ]);
  });

  test("a server that never answers times out and writes no row", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    const app = await withDecider("typesafe/jev-1.13");
    const decider = app.deciders.current()!;
    const providers = {
      byId: (id: string) => app.providers.byId(id),
      decisions: (id: string, req, signal) =>
        requestDecisions(
          app.providers.byId(id)!,
          { fetcher: hang, secret: () => "sk-router" },
          req,
          signal,
        ),
    } as ProvidersPort;
    const recorded: unknown[] = [];
    const usage = { recordDecision: (row: unknown) => recorded.push(row) };
    const asked = ask(
      { clock: () => app.now.value, providers, usage },
      decider,
      use,
      OUTCOME,
      "A report.",
      20,
      new AbortController().signal,
    );
    await expect(asked).rejects.toThrow("router did not answer in time");
    expect(recorded).toEqual([]);
  });
});
