// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The built-in tools: get_current_time, webfetch and websearch. The area
// answers offered(now) with the schemas the model gets and the search
// provider chosen for the send's life, and run(offered, call, ctx) with
// the call's result. The runner holds the offered snapshot on the policy
// and never a key: the key is read here from the secrets port at each
// call, so a key gone since is a failed result, never a switch. Anything
// that reaches a provider goes through the fetcher compose option, so a
// test passes a fake and the suite never reaches a network.

import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { ChatTool, ToolCall } from "../providers/index.ts";
import type { SearchProvider } from "./builtin/search/types.ts";
import { formatCurrentTime, HOST_TIMEZONE, timeTool } from "./builtin/time.ts";
import {
  type FetchDependencies,
  makeWebfetchTool,
} from "./builtin/webfetch.ts";
import {
  makeWebsearchTool,
  type SearchDependencies,
} from "./builtin/websearch.ts";
import { Registry } from "./registry.ts";
import type { Offered, ToolContext, ToolResult } from "./types.ts";

export { dateLine, formatCurrentTime, HOST_TIMEZONE } from "./builtin/time.ts";
export { TOOL_CAPS } from "./limits.ts";
export type {
  Offered,
  Tool,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "./types.ts";

export type ToolsDeps = {
  // what reaches a provider; a test passes a fake (the compose fetcher)
  fetcher: typeof fetch;
  // the secrets port: the bare value or null. A search key is read here,
  // never by the runner
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  // the User-Agent the three request builders carry: 1ctx/<version>
  version: string;
  // test seams for the two network tools; production leaves them unset
  fetchDeps?: FetchDependencies;
  searchDeps?: SearchDependencies;
};

export type Tools = {
  // the schemas and the search provider chosen for the send, the
  // {{year}} filled in the host's timezone
  offered(now: number): Offered;
  // one call's result; a throw is turned into a failed result, never a
  // rejection the runner must catch
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
};

// a description may carry {{year}}, filled at send time in the host's
// timezone: a model searching for "the latest" tends to write the year
// its weights end in, so the year sits where the query is composed
function fillYear(tools: ChatTool[], now: number): ChatTool[] {
  const year = formatCurrentTime(now, HOST_TIMEZONE).datetime.slice(0, 4);
  return tools.map((tool) => ({
    ...tool,
    description: tool.description.replaceAll("{{year}}", year),
  }));
}

export function toolsArea(deps: ToolsDeps): Tools {
  const fetchDeps: FetchDependencies = deps.fetchDeps ?? {
    fetch: deps.fetcher,
  };
  const searchDeps: SearchDependencies = deps.searchDeps ?? {
    fetch: deps.fetcher,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };

  // the search provider chosen once per send: exa when exa.key exists,
  // else firecrawl when firecrawl.key exists, else none and websearch is
  // not offered (decision 3). An empty or unreadable key is the same as
  // none, which the secrets port already answers as null.
  const chooseSearch = (): SearchProvider | null => {
    if (deps.secret("exa") !== null) return "exa";
    if (deps.secret("firecrawl") !== null) return "firecrawl";
    return null;
  };

  // the tools a send runs with, in order: time, webfetch, and websearch
  // only when a search provider was chosen. The websearch tool reads its
  // key from the secrets port at each call, so a key gone since offered()
  // is a failed result, never a switch.
  const toolsFor = (search: SearchProvider | null) => {
    const tools = [timeTool, makeWebfetchTool(deps.version, fetchDeps)];
    if (search !== null) {
      const keyName = search === "exa" ? "exa" : "firecrawl";
      tools.push(
        makeWebsearchTool(
          () => deps.secret(keyName),
          search,
          deps.version,
          searchDeps,
        ),
      );
    }
    return tools;
  };

  return {
    offered(now) {
      const search = chooseSearch();
      const schemas: ChatTool[] = toolsFor(search).map(
        ({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }),
      );
      return { tools: fillYear(schemas, now), search };
    },
    run(offered, call, ctx) {
      return new Registry(toolsFor(offered.search)).run(call, ctx);
    },
  };
}
