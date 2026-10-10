// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The set offered to one send, shared by the agent page and the runner.

import {
  AUTOMATIONS,
  credentialKey,
  EMAIL,
  KNOWLEDGE,
  MEMORY,
  mcpKey,
  skillKey,
  VISUALIZE,
  WEB,
} from "../../shared/capabilities.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { PromptServer } from "../../shared/mcp.ts";
import { mcpCatalog, resolveMode } from "../../shared/mcp-catalog.ts";
import { catalog } from "../../shared/skills.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import {
  AUTOMATION_TOOL,
  EMAIL_TOOL,
  type McpMode,
  type SearchProvider,
} from "../../shared/words.ts";
import type { CredentialRow } from "../credentials/index.ts";
import type { Log } from "../lib/log.ts";
import type { Mcp, OfferedServer } from "../mcp/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import { type ChatTool, wireTokens } from "../providers/index.ts";
import { CATALOG_CAP } from "../skills/index.ts";
import { ATTENTION_TOOL, makeAttentionTool } from "./builtin/attention.ts";
import { isReadMethod } from "./builtin/bash.ts";
import { DELEGATE_TOOL, makeDelegateTool } from "./builtin/delegate.ts";
import { makeMcpCatalogTools } from "./builtin/mcp.ts";
import {
  makeChatMemoryHandle,
  makeMemoryHandle,
  makeMemoryTools,
} from "./builtin/memory.ts";
import { makeSkillTools, type SkillToolsPort } from "./builtin/skill.ts";
import { fillYear, schema } from "./catalog.ts";
import type { ToolStore } from "./store.ts";
import type {
  AttentionHandle,
  MemoryHandle,
  MemoryScope,
  Offered,
  OfferedCredential,
  Tool,
  ToolResult,
} from "./types.ts";

export type SkillsPort = SkillToolsPort & {
  forAgent(agentId: string): OfferedSkill[];
};

// the credentials bound to a project, in name order
export type CredentialsPort = {
  forProject(projectId: string): CredentialRow[];
};

export type SendCredentials = {
  offered: OfferedCredential[];
  off: Offered["credentialsOff"];
};

const NO_CREDENTIALS: SendCredentials = { offered: [], off: [] };

type OfferDeps = {
  store: Pick<ToolStore, "row">;
  skills: SkillsPort;
  mcp: Pick<Mcp, "offered">;
  memory?: Pick<MemoryCapability, "work" | "edit" | "refuse">;
  credentials?: CredentialsPort;
  // the admin's email_user row is on and email is set up
  emailOn?(): boolean;
  // the admin's automation row is on and the tasks are wired to read
  automationOn?(): boolean;
  toolsFor(
    search: SearchProvider | null,
    hosts: readonly string[],
    web: WebSnapshot | null,
    visuals: boolean,
    knowledge: boolean,
    credentials: SendCredentials,
    subagent?: boolean,
  ): Tool<string | ToolResult>[];
  log: Log;
};

// credentials ride on the network: none without it, and none outside a
// project. A subagent's are read-only, so curl never writes through one.
function credentialsFor(
  port: CredentialsPort | undefined,
  projectId: string | null | undefined,
  web: WebSnapshot | null,
  disabledCapabilities: readonly string[],
  readOnly: boolean,
): SendCredentials {
  if (port === undefined || web === null || !projectId) return NO_CREDENTIALS;
  const offered: SendCredentials["offered"] = [];
  const off: SendCredentials["off"] = [];
  for (const row of port.forProject(projectId)) {
    if (disabledCapabilities.includes(credentialKey(row.id))) {
      off.push({ id: row.id, name: row.name, prefix: row.prefix });
      continue;
    }
    // a subagent's write-only credential refuses, never goes out unsigned
    if (readOnly && !row.methods.some(isReadMethod)) {
      off.push({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        writes: true,
      });
      continue;
    }
    offered.push({
      id: row.id,
      name: row.name,
      keyName: row.keyName,
      prefix: row.prefix,
      header: row.header,
      template: row.template,
      methods: [...row.methods],
      ...(readOnly ? { readOnly: true as const } : {}),
    });
  }
  return { offered, off };
}

function memoryFor(
  memory: OfferDeps["memory"],
  scope: MemoryScope | undefined,
  disabledCapabilities: readonly string[],
): MemoryHandle | null {
  if (scope === undefined || memory === undefined) return null;
  if (scope.phase === "memory") {
    if (
      scope.projectId === null ||
      scope.automation === null ||
      !scope.automation.ownMemory
    ) {
      return null;
    }
    return makeMemoryHandle(memory.work(scope.projectId, scope.automation.id));
  }
  // a chat's main rounds save to the project's note, a run's never do;
  // the switch drops the tool and leaves the note in the prompt
  const chat = scope.chat ?? null;
  if (
    chat === null ||
    scope.automation !== null ||
    disabledCapabilities.includes(MEMORY)
  ) {
    return null;
  }
  // the agent page counts the schema with no project to save to
  const projectId = (): string => {
    if (scope.projectId === null) throw new Error("no project to save to");
    return scope.projectId;
  };
  return makeChatMemoryHandle({
    edit: (edit) => memory.edit(projectId(), chat.sessionId, edit, chat.userId),
    refuse: (reason) => memory.refuse(projectId(), chat.sessionId, reason),
  });
}

// only a run's attention step, after its main rounds: never a chat, a
// run's main rounds or its memory phase
function attentionFor(scope: MemoryScope | undefined): AttentionHandle | null {
  const attention = scope?.automation?.attention ?? null;
  if (scope?.phase !== "attention" || attention === null) return null;
  return { guidance: attention.guidance, reason: null };
}

const EMPTY: Omit<Offered, "tools" | "memory"> = {
  visuals: false,
  knowledge: false,
  web: null,
  search: null,
  skills: { block: "", skills: [] },
  mcp: [],
  mcpPrompt: { text: "", digest: {} },
  mcpCatalog: "",
  credentials: [],
  credentialsOff: [],
};

function promptServers(servers: OfferedServer[]): PromptServer[] {
  return servers.map((server) => ({
    name: server.name,
    instructions: server.instructions,
    tools: server.tools.map((tool) => ({
      wireName: tool.wireName,
      description: tool.description,
      schemaJson: tool.schemaJson,
    })),
  }));
}

function directSchemas(servers: OfferedServer[]): ChatTool[] {
  return servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      parameters: tool.wireInputSchema,
    })),
  );
}

// what a subagent is never offered, whatever its parent has: MCP's
// write side goes by the links below
const CHILD_CUT: ReadonlySet<string> = new Set([
  DELEGATE_TOOL,
  "memory_edit",
  EMAIL_TOOL,
  "visualize",
  ATTENTION_TOOL,
]);

// A subagent's offer, the one place it is decided: its parent's main
// offer less CHILD_CUT and every MCP tool on the write side, the links
// read alone so offeredServers() drops the write side as it always
// decides it. Its bash leaves out open and its credentials sign GET
// and HEAD alone. The trimmed array never shares
// the parent's cached prefix; the alternative is the parent's array
// here with the cut names refused at dispatch.
function childOffered(
  deps: OfferDeps,
  now: number,
  agentId: string,
  agentServers: AgentServer[],
  requestedMode: McpMode,
  scope: MemoryScope,
  disabledCapabilities: readonly string[],
): Offered {
  const main = offered(
    deps,
    now,
    agentId,
    agentServers.map((link) => ({ ...link, write: false })),
    requestedMode,
    {
      projectId: scope.projectId,
      automation: null,
      phase: "main",
      origin: scope.origin,
    },
    disabledCapabilities,
    true,
  );
  return {
    ...main,
    tools: main.tools.filter((tool) => !CHILD_CUT.has(tool.name)),
    memory: null,
    subagent: true,
  };
}

export function offered(
  deps: OfferDeps,
  now: number,
  agentId: string,
  agentServers: AgentServer[] = [],
  requestedMode: McpMode = "auto",
  scope?: MemoryScope,
  disabledCapabilities: readonly string[] = [],
  // building a subagent's offer: its bash says nothing of open and its
  // credentials are read-only
  subagent = false,
): Offered {
  if (scope?.phase === "child") {
    return childOffered(
      deps,
      now,
      agentId,
      agentServers,
      requestedMode,
      scope,
      disabledCapabilities,
    );
  }
  if (scope?.phase === "attention") {
    const attention = attentionFor(scope);
    return {
      ...EMPTY,
      tools: attention === null ? [] : [schema(makeAttentionTool(attention))],
      memory: null,
      attention,
    };
  }
  const memory = memoryFor(deps.memory, scope, disabledCapabilities);
  if (scope?.phase === "memory") {
    const phaseTools = memory === null ? [] : makeMemoryTools(memory);
    return {
      ...EMPTY,
      tools: fillYear(phaseTools.map(schema), now),
      memory,
    };
  }
  const visualRow = deps.store.row("visualize");
  const visuals = visualRow.enabled;
  const knowledge = !disabledCapabilities.includes(KNOWLEDGE);
  const access = deps.store.row("web");
  const web: WebSnapshot | null =
    access.mode === "off" || disabledCapabilities.includes(WEB)
      ? null
      : {
          mode: access.mode as WebSnapshot["mode"],
          domains: [...access.hosts],
        };
  const search = web === null ? null : deps.store.row("websearch").provider;
  const credentials = credentialsFor(
    deps.credentials,
    scope?.projectId,
    web,
    disabledCapabilities,
    subagent,
  );
  // a chat's main rounds, a summoned agent's and a chat's subagents: a
  // run's subagent offer has no automation of its own, so its origin
  // says it is a run's
  const chatSend =
    scope?.phase === "main" &&
    scope.automation === null &&
    scope.origin !== "automation";
  const allowed = new Set<string>([
    "datetime",
    "bash",
    ...(web === null ? [] : ["webfetch"]),
    ...(search === null ? [] : ["websearch"]),
    // the chat's own switch removes the tool and only the tool: open
    // and the skill read the admin's row alone
    ...(visuals && !disabledCapabilities.includes(VISUALIZE)
      ? ["visualize"]
      : []),
    ...(deps.emailOn?.() && !disabledCapabilities.includes(EMAIL)
      ? [EMAIL_TOOL]
      : []),
    ...(chatSend &&
    deps.automationOn?.() &&
    !disabledCapabilities.includes(AUTOMATIONS)
      ? [AUTOMATION_TOOL]
      : []),
  ]);
  // a skill the chat turned off is in no part of the send: the catalog,
  // the skill tools' snapshot and the file tool all come from what is
  // left, and the catalog never narrows it
  const agentSkills = deps.skills
    .forAgent(agentId)
    .filter((skill) => !disabledCapabilities.includes(skillKey(skill.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skillCatalog = catalog(agentSkills, CATALOG_CAP);
  if (skillCatalog.overCap) {
    deps.log.warn("catalog over cap", {
      kind: "skills",
      count: agentSkills.length,
    });
  }
  const skills = { block: skillCatalog.text, skills: agentSkills };
  const baseTools = fillYear(
    [
      ...deps
        .toolsFor(
          search,
          visualRow.hosts,
          web,
          visuals,
          knowledge,
          credentials,
          subagent,
        )
        .filter((tool) => allowed.has(tool.name)),
      ...makeSkillTools(skills.skills, deps.skills),
      ...(memory === null ? [] : makeMemoryTools(memory)),
      // a main offer of an agent whose Subagents switch is on
      ...(scope?.phase === "main" && scope.delegate
        ? [makeDelegateTool()]
        : []),
    ].map(schema),
    now,
  );
  const offered = deps.mcp.offered(
    agentServers.filter(
      (link) => !disabledCapabilities.includes(mcpKey(link.serverId)),
    ),
  );
  // the catalog never narrows the offer: every offered server keeps its
  // instructions, its digest and its tools in either mode
  const mcp = offered.servers;
  const mcpPrompt = {
    text: offered.prompt.text,
    digest: offered.prompt.digest,
  };
  let mcpCatalogText = "";
  const allSchemas = directSchemas(mcp);
  const schemaTokens = wireTokens(allSchemas);
  const mode = resolveMode(requestedMode, schemaTokens);
  let mcpSchemas = allSchemas;
  if (mode === "catalog" && mcp.length > 0) {
    const catalogOffer = mcpCatalog(promptServers(mcp));
    if (catalogOffer.overCap) {
      deps.log.warn("catalog over cap", {
        kind: "mcp",
        count: mcp.reduce((n, server) => n + server.tools.length, 0),
      });
    }
    mcpCatalogText = catalogOffer.text;
    // no tool to list means no catalog, and neither tool could answer
    mcpSchemas =
      mcpCatalogText === "" ? [] : makeMcpCatalogTools(mcp).map(schema);
  }
  return {
    tools: [...baseTools, ...mcpSchemas],
    visuals,
    knowledge,
    web,
    search,
    skills,
    mcp,
    mcpPrompt,
    mcpCatalog: mcpCatalogText,
    memory,
    credentials: credentials.offered,
    credentialsOff: credentials.off,
  };
}
