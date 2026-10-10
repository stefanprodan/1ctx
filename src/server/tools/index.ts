// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchToolRequest,
  ToolsResponse,
  VisualCounts,
  WebCounts,
} from "../../shared/api/tools.ts";
import {
  AUTOMATIONS,
  EMAIL,
  KNOWLEDGE,
  MEMORY,
  skillKey,
  VISUALIZE,
  WEB,
} from "../../shared/capabilities.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { WebAccess, WebSnapshot } from "../../shared/web.ts";
import {
  AUTOMATION_TOOL,
  EMAIL_TOOL,
  type McpMode,
  type SearchProvider,
} from "../../shared/words.ts";
import type { BashCapability } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { Mcp, OfferedMcpTool, OfferedServer } from "../mcp/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ToolCall } from "../providers/index.ts";
import { type AgentEmailDeps, agentEmails } from "./agent-email.ts";
import { withCommandHints } from "./bash-hint.ts";
import { ATTENTION_TOOL, makeAttentionTool } from "./builtin/attention.ts";
import {
  type AutomationsPort,
  makeAutomationTool,
} from "./builtin/automation.ts";
import { type CredentialKeysPort, makeBashTool } from "./builtin/bash.ts";
import { datetimeTool } from "./builtin/datetime.ts";
import {
  DELEGATE_TOOL,
  type DelegatePort,
  runDelegate,
} from "./builtin/delegate.ts";
import { makeEmailTool } from "./builtin/email.ts";
import {
  asMcpCall,
  checkMcpArguments,
  makeMcpCatalogTools,
  mcpCallName,
  resolveMcpCall,
} from "./builtin/mcp.ts";
import { runMemory } from "./builtin/memory.ts";
import { makeSkillTools } from "./builtin/skill.ts";
import { makeVisualizeTool } from "./builtin/visualize.ts";
import { makeWebfetchTool } from "./builtin/webfetch.ts";
import {
  abortableSleep,
  makeWebsearchTool,
  type SearchDependencies,
} from "./builtin/websearch.ts";
import { shapeMcpResult } from "./kept.ts";
import { toolLogName } from "./log-name.ts";
import {
  type CredentialsPort,
  offered,
  type SendCredentials,
  type SkillsPort,
} from "./offer.ts";
import type { ToolName } from "./parse.ts";
import { failedCall, Registry } from "./registry.ts";
import { toolsResponse } from "./response.ts";
import { routes } from "./routes.ts";
import { ToolStore } from "./store.ts";
import type {
  MemoryScope,
  Offered,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.ts";

export { ATTENTION_TOOL } from "./builtin/attention.ts";
export type {
  AutomationsPort,
  LastRun,
  SwitchNames,
} from "./builtin/automation.ts";
export { asSubagent } from "./builtin/bash.ts";
export {
  DELEGATE_DESCRIPTION,
  DELEGATE_TOOL,
  type DelegateInput,
  type DelegatePort,
} from "./builtin/delegate.ts";
export {
  CHAT_MEMORY_DESCRIPTION,
  isMemoryTool,
  MEMORY_WRITE_RULES,
} from "./builtin/memory.ts";
export { toolLogName } from "./log-name.ts";
export type { SkillsPort } from "./offer.ts";
export {
  isToolName,
  parseHosts,
  parseWebDomains,
  TOOL_FIELDS,
  TOOL_NAMES,
  type ToolName,
} from "./parse.ts";
export type {
  KeepPort,
  MemoryScope,
  Offered,
  SendRepos,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "./types.ts";

export type ToolsDeps = {
  db: Db;
  fetcher: typeof fetch;
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  render: (markdown: string) => string;
  skills: SkillsPort;
  mcp?: Pick<Mcp, "offered" | "switchable" | "call" | "validateArguments">;
  memory?: Pick<MemoryCapability, "work" | "edit" | "refuse">;
  bash?: Pick<BashCapability, "run">;
  // the project's credentials for a send, and each row and key again at
  // each command
  credentials?: CredentialsPort & CredentialKeysPort;
  searchDeps?: SearchDependencies;
  // email_user's: whether email is set up, and what the tool reads and
  // queues; without it the tool is never offered
  email?: Omit<AgentEmailDeps, "db" | "clock"> & { enabled(): boolean };
  usage?: {
    visuals(since: number, until: number): VisualCounts;
    web(since: number, until: number): WebCounts;
  };
  // the runner's child run, a closure since the runner is built later
  delegate?: DelegatePort;
  // what the automation tool reads; without it the tool is never offered
  automations?: AutomationsPort;
};

export type Tools = {
  capabilities(): string[];
  serverNames(links: AgentServer[]): string[];
  // the names of the agent's skills a disabled set turns off
  skillsOff(agentId: string, disabledCapabilities: readonly string[]): string[];
  offered(
    now: number,
    agentId: string,
    agentServers?: AgentServer[],
    mode?: McpMode,
    scope?: MemoryScope,
    disabledCapabilities?: readonly string[],
  ): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toolName?(offered: Offered, call: ToolCall): string;
  logName?(offered: Offered, call: ToolCall): string;
  normalize?(offered: Offered, calls: ToolCall[]): ToolCall[];
  routes?: RouteDescriptor[];
};

export type ToolsArea = Tools & {
  webAccess(): WebAccess;
  store: ToolStore;
  routes: RouteDescriptor[];
};

// the memory phase is offered memory_edit and nothing else; a call to
// anything the run had gets the reason rather than a bare not found
const PHASE_ONLY = "only memory_edit is offered in the memory phase.";
// the attention step likewise offers needs_attention alone
const ATTENTION_ONLY = `only ${ATTENTION_TOOL} is offered in this step.`;
// an MCP call's own timer runs this far past the registry's, so two
// timers never race and the timeout words are the registry's
const MCP_BACKSTOP_MS = 1000;

// the row each switch moves: a tool's own, named, so no switch moves
// another's
function switchOf(name: ToolName): SwitchedTool {
  if (name === "web" || name === "websearch") {
    throw new BadRequest(`${name} has no switch`);
  }
  return name;
}

type SwitchedTool = Exclude<ToolName, "web" | "websearch">;

export function toolsArea(deps: ToolsDeps): ToolsArea {
  const store = new ToolStore(deps.db);
  const skillStore: SkillsPort = deps.skills;
  const mcpService = deps.mcp ?? {
    switchable: () => [],
    offered: () => ({
      servers: [],
      prompt: {
        text: "",
        included: [],
        leftForSchemas: [],
        leftForInstructions: [],
        digest: {},
      },
    }),
    async call() {
      throw new Error("MCP is not configured");
    },
    validateArguments: () => null,
  };
  const searchDeps: SearchDependencies = deps.searchDeps ?? {
    fetch: deps.fetcher,
    sleep: abortableSleep,
  };
  const email = deps.email;
  const emailPort =
    email === undefined
      ? null
      : agentEmails({ db: deps.db, clock: deps.clock, ...email });
  // the admin's row and a server set up: a send is offered the tool only
  // with both
  const emailOn = () =>
    email !== undefined && store.row(EMAIL_TOOL).enabled && email.enabled();
  const automations = deps.automations ?? null;
  // the admin's row, with the tasks wired to read
  const automationOn = () =>
    automations !== null && store.row(AUTOMATION_TOOL).enabled;

  const toolsFor = (
    search: SearchProvider | null,
    hosts: readonly string[],
    web: WebSnapshot | null,
    visuals: boolean,
    knowledge: boolean,
    credentials: SendCredentials,
    subagent = false,
  ): Tool<string | ToolResult>[] => [
    datetimeTool,
    ...(web === null ? [] : [makeWebfetchTool(deps.fetcher, web)]),
    ...(search === null
      ? []
      : [
          makeWebsearchTool(
            () => deps.secret(`search-${search}`),
            search,
            searchDeps,
          ),
        ]),
    makeVisualizeTool(hosts),
    makeEmailTool(emailPort),
    makeAutomationTool(automations),
    makeBashTool({
      bash: deps.bash,
      web,
      visuals,
      credentials,
      keys: deps.credentials,
      docs: knowledge,
      subagent,
    }),
  ];

  const mcpTools = (
    servers: OfferedServer[],
    ctx: ToolContext,
  ): Tool<string | ToolResult>[] =>
    servers.flatMap((server) =>
      server.tools.map((tool: OfferedMcpTool) => {
        const timeoutMs = server.timeoutMs ?? ctx.caps.callTimeoutMs;
        return {
          name: tool.wireName,
          description: tool.description,
          parameters: tool.wireInputSchema,
          timeoutMs,
          run: async (args: Record<string, unknown>, runCtx: ToolContext) => {
            checkMcpArguments(tool, args, mcpService.validateArguments);
            return shapeMcpResult(
              await mcpService.call(server, tool, args, {
                signal: runCtx.signal,
                timeoutMs: timeoutMs + MCP_BACKSTOP_MS,
                bodyBytes: runCtx.caps.fetchBodyBytes,
              }),
              tool.name,
              runCtx.keep,
              runCtx.caps.resultCut,
            );
          },
        };
      }),
    );

  const webAccess = (): WebAccess => {
    const row = store.row("web");
    return {
      mode: row.mode!,
      domains: row.hosts,
      updatedAt: row.updatedAt,
    };
  };

  const response = (now: number): ToolsResponse =>
    toolsResponse({
      store,
      access: webAccess(),
      render: deps.render,
      secret: deps.secret,
      emailOn: email?.enabled() ?? false,
      now,
    });

  const patch = (
    name: ToolName,
    change: PatchToolRequest,
    now: number,
  ): void => {
    transact(deps.db, () => {
      if (name === "web") {
        const row = store.row("web");
        const mode = change.mode ?? row.mode!;
        const domains = change.domains ?? row.hosts;
        if (mode === "listed" && domains.length === 0)
          throw new BadRequest("list at least one host");
        store.setAccess(mode, domains, now);
      }
      if (change.enabled !== undefined) {
        store.setEnabled(switchOf(name), change.enabled, now);
      }
      if ("provider" in change) store.setProvider(change.provider ?? null, now);
      if (change.hosts !== undefined) store.setHosts(change.hosts, now);
      return { result: undefined };
    });
  };

  const area: ToolsArea = {
    store,
    webAccess,
    capabilities: () => [
      ...(webAccess().mode === "off" ? [] : [WEB]),
      ...(store.row("visualize").enabled ? [VISUALIZE] : []),
      ...(emailOn() ? [EMAIL] : []),
      ...(automationOn() ? [AUTOMATIONS] : []),
      // no admin row governs these
      KNOWLEDGE,
      MEMORY,
    ],
    serverNames: (links) =>
      mcpService.switchable(links).map((server) => server.name),
    skillsOff: (agentId, disabledCapabilities) =>
      skillStore
        .forAgent(agentId)
        .filter((skill) => disabledCapabilities.includes(skillKey(skill.id)))
        .map((skill) => skill.name),
    routes: [],
    offered(
      now,
      agentId,
      agentServers,
      requestedMode,
      scope,
      disabledCapabilities,
    ) {
      return offered(
        {
          store,
          skills: skillStore,
          mcp: mcpService,
          memory: deps.memory,
          credentials: deps.credentials,
          emailOn,
          automationOn,
          toolsFor,
          log: deps.log,
        },
        now,
        agentId,
        agentServers,
        requestedMode,
        scope,
        disabledCapabilities,
      );
    },
    normalize(offered, calls) {
      if (
        offered.mcpCatalog === "" ||
        !offered.tools.some((tool) => tool.name === "mcp_call")
      )
        return calls;
      return calls.map((call) => asMcpCall(offered.mcp, call));
    },
    toolName(offered, call) {
      return mcpCallName(offered.mcp, call) ?? call.name;
    },
    logName(offered, call) {
      return toolLogName(offered, call);
    },
    async run(offered, call, ctx) {
      ctx = { ...ctx, web: offered.web };
      const memory = offered.memory;
      if (memory !== null && call.name === "memory_edit") {
        return runMemory(memory, call, ctx);
      }
      const attention = offered.attention ?? null;
      if (attention !== null) {
        return new Registry(
          [makeAttentionTool(attention)],
          () => ATTENTION_ONLY,
        ).run(call, ctx);
      }
      // the memory phase offers nothing but memory_edit, handled above
      if (memory?.work) {
        return new Registry([], () => PHASE_ONLY).run(call, ctx);
      }
      const allowed = new Set(offered.tools.map((tool) => tool.name));
      // no await before it: the runner reserves a child's place in the
      // same turn the round's calls launch
      if (call.name === DELEGATE_TOOL && allowed.has(DELEGATE_TOOL)) {
        return runDelegate(deps.delegate, call, ctx);
      }
      const catalog =
        offered.mcpCatalog === ""
          ? []
          : offered.mcp.flatMap((server) =>
              server.tools.map((tool) => tool.wireName),
            );
      const base = [
        ...toolsFor(
          offered.search,
          [],
          offered.web,
          offered.visuals,
          offered.knowledge,
          {
            offered: offered.credentials,
            off: offered.credentialsOff,
          },
          offered.subagent,
        )
          .filter((tool) => allowed.has(tool.name))
          .map((tool) =>
            tool.name === "bash"
              ? withCommandHints(tool, [...allowed], catalog)
              : tool,
          ),
        ...makeSkillTools(offered.skills.skills, skillStore).filter((tool) =>
          allowed.has(tool.name),
        ),
      ];
      const direct = mcpTools(offered.mcp, ctx);
      if (call.name === "mcp_call" && allowed.has("mcp_call")) {
        try {
          const target = resolveMcpCall(
            offered.mcp,
            call,
            mcpService.validateArguments,
          );
          return new Registry([...base, ...direct]).run(target, ctx);
        } catch (error) {
          return failedCall(error, ctx);
        }
      }
      const runtime =
        offered.mcpCatalog === ""
          ? [...base, ...direct]
          : [...base, ...makeMcpCatalogTools(offered.mcp)];
      return new Registry(runtime).run(call, ctx);
    },
  };
  area.routes = routes({
    clock: deps.clock,
    visuals: (since, until) =>
      deps.usage?.visuals(since, until) ?? { drawn: 0, failed: 0, opened: 0 },
    web: (since, until) =>
      deps.usage?.web(since, until) ?? { fetches: 0, searches: 0, failed: 0 },
    response,
    patch,
    visualHosts: () => store.row("visualize").hosts,
  });
  return area;
}
