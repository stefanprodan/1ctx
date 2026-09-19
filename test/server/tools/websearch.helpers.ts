// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SearchProvider } from "../../../src/server/tools/builtin/search/types.ts";
import type {
  Search,
  SearchDependencies,
} from "../../../src/server/tools/builtin/websearch.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type {
  ToolBudget,
  ToolContext,
} from "../../../src/server/tools/types.ts";

export const exaFixture = await Bun.file(
  new URL("../../fixtures/tools/exa-search.txt", import.meta.url),
).text();
export const firecrawlFixture = await Bun.file(
  new URL("../../fixtures/tools/firecrawl-search.json", import.meta.url),
).text();
export const tavilyFixture = await Bun.file(
  new URL("../../fixtures/tools/tavily-search.json", import.meta.url),
).text();
export const exaPayload = exaFixture
  .split(/\r?\n/u)
  .find((line) => line.startsWith("data: "))!
  .slice(6);
export const exaText = JSON.parse(exaPayload).result.content[0].text as string;
const successEnvelope = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "result" }] },
});

export function budget(): ToolBudget {
  return { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 };
}

export function context(
  signal = new AbortController().signal,
  shared = budget(),
  deadlineMs = 10_000,
): ToolContext {
  return {
    actor: null,
    web: null,
    signal,
    now: Date.now,
    budget: shared,
    caps: { ...TOOL_CAPS, searchDeadlineMs: deadlineMs },
  };
}

export function search(
  provider: SearchProvider = "exa",
  key: string | null = null,
): Search {
  return { provider, key };
}

export function dependencies(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  sleep?: SearchDependencies["sleep"],
): SearchDependencies {
  return {
    fetch: fetcher as typeof fetch,
    sleep:
      sleep ??
      (async (_ms, signal) => {
        signal.throwIfAborted();
      }),
  };
}

export function streamResponse(
  chunks: Array<string | Uint8Array>,
  init: ResponseInit = {},
  cancelled?: () => void,
  close = true,
  cancelOutcome: "settle" | "reject" | "hang" = "settle",
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        }
        if (close) controller.close();
      },
      cancel() {
        cancelled?.();
        if (cancelOutcome === "reject") return Promise.reject(new Error("no"));
        if (cancelOutcome === "hang") return new Promise<void>(() => {});
        return undefined;
      },
    }),
    init,
  );
}

export function exaResponse(text = successEnvelope): Response {
  return streamResponse([text], {
    headers: { "content-type": "application/json" },
  });
}

export function firecrawlResponse(): Response {
  return streamResponse(
    [JSON.stringify({ success: true, data: { web: [] } })],
    {
      headers: { "content-type": "application/json" },
    },
  );
}

export function tavilyResponse(): Response {
  return streamResponse([JSON.stringify({ results: [] })], {
    headers: { "content-type": "application/json" },
  });
}

export async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}
