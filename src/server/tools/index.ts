// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The built-in tools, datetime, webfetch and websearch, and
// their server-wide settings: the switch on each and the search
// provider, rows in the tools table an admin changes on the Tools page.
// offered(now) answers the schemas the model gets, every enabled tool
// and websearch only when a provider was chosen, and that provider for
// the send's life; run(offered, call, ctx)
// answers a call's result from that snapshot alone, so a tool switched
// off mid-send is still run by a send that was offered it and a tool
// the model names outside its set is a failed result. The runner holds
// the snapshot on the policy and never a key: the key is read here from
// the secrets port at each call, and both providers answer without one.
// Anything that reaches a provider goes through
// the fetcher compose option, so a test passes a fake and the suite
// never reaches a network.

import type {
  PatchToolRequest,
  ToolsResponse,
} from "../../shared/api/tools.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { ToolSummary } from "../../shared/contracts/tool.ts";
import { catalog } from "../../shared/skills.ts";
import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  type SearchProvider,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { ChatTool, ToolCall } from "../providers/index.ts";
import { CATALOG_CAP } from "../skills/index.ts";
import {
  DEFAULT_TIMEZONE,
  datetimeTool,
  formatDatetime,
} from "./builtin/datetime.ts";
import { makeSkillTools, type SkillToolsPort } from "./builtin/skill.ts";
import {
  type FetchDependencies,
  makeWebfetchTool,
} from "./builtin/webfetch.ts";
import {
  makeWebsearchTool,
  type SearchDependencies,
} from "./builtin/websearch.ts";
import { Registry } from "./registry.ts";
import { routes } from "./routes.ts";
import { ToolStore } from "./store.ts";
import type { Offered, Tool, ToolContext, ToolResult } from "./types.ts";

export { DEFAULT_TIMEZONE, formatDatetime } from "./builtin/datetime.ts";
export { TOOL_CAPS } from "./limits.ts";
export { parseToolName, parseToolPatch } from "./parse.ts";
export { type ToolRow, ToolStore } from "./store.ts";
export type {
  Offered,
  Tool,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "./types.ts";

export type SkillsPort = SkillToolsPort & {
  forAgent(agentId: string): OfferedSkill[];
};

export type ToolsDeps = {
  db: Db;
  // what reaches a provider; a test passes a fake (the compose fetcher)
  fetcher: typeof fetch;
  // the secrets port: the bare value or null. A search key is read here,
  // never by the runner
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  // the User-Agent the three request builders carry: 1ctx/<version>
  version: string;
  // keeps Markdown parsing and highlighting at the server safety boundary
  render: (markdown: string, streaming: boolean) => string;
  skills: SkillsPort;
  // test seams for the two network tools; production leaves them unset
  fetchDeps?: FetchDependencies;
  searchDeps?: SearchDependencies;
};

export type Tools = {
  // the schemas and the search provider chosen for the send, the
  // {{year}} filled in UTC
  offered(now: number, agentId: string): Offered;
  // one call's result; a throw is turned into a failed result, never a
  // rejection the runner must catch
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  // the Tools page's routes; a test's seam may leave them out
  routes?: RouteDescriptor[];
};

export type ToolsArea = Tools & {
  store: ToolStore;
  routes: RouteDescriptor[];
};

// a description may carry {{year}}, filled at send time in UTC, the
// zone of the prompt's date line: a model searching for "the latest" tends to write the year
// its weights end in, so the year sits where the query is composed
function fillYear(tools: ChatTool[], now: number): ChatTool[] {
  const year = formatDatetime(now, DEFAULT_TIMEZONE).datetime.slice(0, 4);
  return tools.map((tool) => ({
    ...tool,
    description: tool.description.replaceAll("{{year}}", year),
  }));
}

export function toolsArea(deps: ToolsDeps): ToolsArea {
  const store = new ToolStore(deps.db);
  const skillStore: SkillsPort = deps.skills;
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

  // the three tools, websearch built for one provider; which of them a
  // send gets is decided by the rows in offered()
  const toolsFor = (search: SearchProvider): Tool[] => [
    datetimeTool,
    makeWebfetchTool(deps.version, fetchDeps),
    makeWebsearchTool(
      () => deps.secret(search),
      search,
      deps.version,
      searchDeps,
    ),
  ];

  // what the Tools page shows: the schema text as the model gets it,
  // read-only, with the switch and whether each key file is there; the
  // key's value never rides
  const response = (now: number): ToolsResponse => {
    const rows = new Map(store.rows().map((row) => [row.name, row]));
    const selected = rows.get("websearch")?.provider ?? "exa";
    const schemas = new Map(
      fillYear(toolsFor(selected), now).map((tool) => [tool.name, tool]),
    );
    const tools: ToolSummary[] = BUILTIN_TOOLS.map((name) => {
      const row = rows.get(name)!;
      const schema = schemas.get(name)!;
      const json = JSON.stringify(schema.parameters, null, 2);
      return {
        name,
        description: schema.description,
        parameters: schema.parameters,
        parametersHtml: deps.render(`\`\`\`json\n${json}\n\`\`\``, false),
        enabled: row.enabled,
        updatedAt: row.updatedAt,
      };
    });
    return {
      tools,
      search: {
        provider: rows.get("websearch")!.provider,
        keys: {
          exa: deps.secret("exa") !== null,
          firecrawl: deps.secret("firecrawl") !== null,
        },
      },
    };
  };

  const patch = (
    name: BuiltinTool,
    change: PatchToolRequest,
    now: number,
  ): void => {
    transact(deps.db, () => {
      if (change.enabled !== undefined) {
        store.setEnabled(name, change.enabled, now);
      }
      if ("provider" in change) store.setProvider(change.provider ?? null, now);
      return { result: undefined };
    });
  };

  const area: ToolsArea = {
    store,
    routes: [],
    offered(now, agentId) {
      const rows = new Map(store.rows().map((row) => [row.name, row]));
      const searchRow = rows.get("websearch")!;
      // the chosen provider, key or not: both answer keyless, so the
      // key file only raises the rate
      const search =
        searchRow.enabled && searchRow.provider !== null
          ? searchRow.provider
          : null;
      const allowed = new Set(
        [...rows.values()]
          .filter((row) => row.enabled && (row.name !== "websearch" || search))
          .map((row) => row.name),
      );
      const skillCatalog = catalog(skillStore.forAgent(agentId), CATALOG_CAP);
      for (const name of skillCatalog.leftOut) {
        deps.log(`skill ${name} left out of the catalog`);
      }
      const skillOffer = {
        block: skillCatalog.text,
        skills: skillCatalog.included,
      };
      const schemas: ChatTool[] = [
        ...toolsFor(search ?? "exa").filter((tool) =>
          allowed.has(tool.name as BuiltinTool),
        ),
        ...makeSkillTools(skillOffer.skills, skillStore),
      ].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      return { tools: fillYear(schemas, now), search, skills: skillOffer };
    },
    run(offered, call, ctx) {
      const allowed = new Set(offered.tools.map((tool) => tool.name));
      const tools = [
        ...toolsFor(offered.search ?? "exa").filter((tool) =>
          allowed.has(tool.name),
        ),
        ...makeSkillTools(offered.skills.skills, skillStore),
      ];
      return new Registry(tools).run(call, ctx);
    },
  };
  area.routes = routes({ clock: deps.clock, response, patch });
  return area;
}
