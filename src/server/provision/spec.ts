// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { HttpMethod } from "../../shared/contracts/credential.ts";
import { sourceKind } from "../../shared/skills.ts";
import { isWebAccessMode, type WebAccessMode } from "../../shared/web.ts";
import {
  type Avatar,
  isAvatar,
  isDescription,
  isMcpMode,
  isName,
  isRole,
  isSearchProvider,
  isSecretName,
  isServerName,
  isSkillName,
  isUsername,
  isWire,
  MAX_DESCRIPTION,
  MAX_SKILLS_PER_AGENT,
  type McpMode,
  type Role,
  type SearchProvider,
  type Wire,
} from "../../shared/words.ts";
import {
  parseAbout,
  parseEmail,
  parseFullName,
  parseTz,
} from "../access/index.ts";
import {
  MAX_SERVERS_PER_AGENT,
  parseEffort,
  parsePrompt,
  parseThinking,
} from "../agents/index.ts";
import {
  parseKeyName as parseCredentialKey,
  parseHeader,
  parseMethods,
  parsePrefix,
  parseTemplate,
} from "../credentials/index.ts";
import { parseModel } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { validPath } from "../lib/paths.ts";
import {
  parseMcpKeyName,
  parsePatterns,
  parseTimeout,
  parseUrl,
} from "../mcp/index.ts";
import {
  azureBaseUrlProblem,
  parseBaseUrl,
  parseKeyName,
} from "../providers/index.ts";
import { MAX_SKILL_URL } from "../skills/index.ts";
import {
  parseHosts,
  parseWebDomains,
  TOOL_FIELDS,
  type ToolName,
} from "../tools/index.ts";
import {
  at,
  boolean,
  guarded,
  names,
  object,
  optional,
  optionalSpec,
} from "./fields.ts";
import type { RepositorySpec } from "./repository.ts";
import type { SmtpServerSpec } from "./smtp.ts";

export type UserSpec = {
  role: Role;
  fullName?: string;
  email?: string;
  tz?: string;
  about?: string;
  disabled?: boolean;
  passwordFrom?: string;
  mustChangePassword?: boolean;
};

export type ProjectSpec = {
  description?: string;
  members?: string[];
  // a folder relative to the file that holds the document
  knowledge?: string;
};

const MAX_FOLDER_PATH = 1024;

// relative and without "..", so the folder stays under the file's own
// directory, the one staging copies
function folderPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_FOLDER_PATH ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new BadRequest("must be a relative folder path without ..");
  }
  return value;
}

export type CredentialSpec = {
  keyFrom?: string;
  url?: string;
  header?: string;
  value?: string;
  methods?: HttpMethod[];
  projects?: string[];
};

export type ProviderSpec = {
  wire?: Wire;
  baseUrl?: string;
  keyFrom?: string | null;
};

export type DeciderSpec = {
  provider?: string;
  model?: string;
  // only true: the decider every feature asks; left out, the mark stays
  // where it is
  default?: true;
};

export type SkillSpec = {
  url?: string;
  fromIndex?: boolean;
  path?: string;
};

export type McpServerSpec = {
  url?: string;
  keyFrom?: string | null;
  read?: boolean;
  write?: boolean;
  instructionsOn?: boolean;
  timeoutMs?: number | null;
  readPatterns?: string[];
  writePatterns?: string[];
  excludedPatterns?: string[];
};

export type AgentSpec = {
  provider?: string;
  model?: string;
  avatar?: Avatar;
  thinking?: "on" | "off" | null;
  effort?: string | null;
  prompt?: string;
  skills?: string[];
  servers?: { name: string; read: boolean; write: boolean }[];
  mcpMode?: McpMode;
  // for a model its catalog does not describe, as the agents API takes
  contextLength?: number | null;
  tools?: boolean;
  // the OpenRouter endpoint tag tried first, as the agents API takes it
  upstream?: string | null;
  // leave out OpenRouter's 4-bit hosts, as the agents API takes it; an
  // upstream changed to a 4-bit host while it stays on is refused
  skip4Bit?: boolean;
  // only true: the agent a new chat starts on for anyone who has not
  // picked one; left out, the mark stays where it is
  default?: true;
};

export type ToolSpec = {
  mode?: WebAccessMode;
  domains?: string[];
  enabled?: boolean;
  provider?: SearchProvider | null;
  hosts?: string[];
};

export type Specs = {
  User: UserSpec;
  SmtpServer: SmtpServerSpec;
  Project: ProjectSpec;
  Credential: CredentialSpec;
  Repository: RepositorySpec;
  Provider: ProviderSpec;
  Decider: DeciderSpec;
  Skill: SkillSpec;
  McpServer: McpServerSpec;
  Agent: AgentSpec;
  Tool: ToolSpec;
};

const USER_FIELDS = [
  "role",
  "fullName",
  "email",
  "tz",
  "about",
  "disabled",
  "passwordFrom",
  "mustChangePassword",
];

export function user(value: unknown): UserSpec {
  const b = object(value, USER_FIELDS, "spec");
  const role = at("spec.role", () =>
    guarded(isRole, "must be admin or member")(b.role),
  );
  return {
    role,
    ...optional<Omit<UserSpec, "role">>(b, {
      fullName: parseFullName,
      email: parseEmail,
      tz: parseTz,
      about: parseAbout,
      disabled: boolean,
      passwordFrom: guarded(
        (v): v is string => isSecretName("user-", v),
        "must name a user- secret without the .key extension",
      ),
      mustChangePassword: boolean,
    }),
  };
}

export function project(value: unknown): ProjectSpec {
  return optionalSpec<ProjectSpec>(value, {
    description: guarded(
      isDescription,
      `must be one trimmed line of at most ${MAX_DESCRIPTION} characters`,
    ),
    members: (v) => names(v, isUsername),
    knowledge: folderPath,
  });
}

export function credential(value: unknown): CredentialSpec {
  return optionalSpec<CredentialSpec>(value, {
    keyFrom: parseCredentialKey,
    url: parsePrefix,
    header: parseHeader,
    value: parseTemplate,
    methods: parseMethods,
    projects: (v) => names(v, isName),
  });
}

export function provider(value: unknown): ProviderSpec {
  const spec = optionalSpec<ProviderSpec>(value, {
    wire: guarded(isWire, "must be a known wire"),
    baseUrl: parseBaseUrl,
    keyFrom: parseKeyName,
  });
  const problem =
    spec.wire === "azure" && spec.baseUrl !== undefined
      ? azureBaseUrlProblem(spec.baseUrl)
      : null;
  if (problem !== null) throw new Error(`spec.baseUrl: ${problem}`);
  return spec;
}

const onlyTrue = (v: unknown): true => {
  if (v !== true) throw new BadRequest("must be true, or left out");
  return v;
};

export function decider(value: unknown): DeciderSpec {
  return optionalSpec<DeciderSpec>(value, {
    provider: guarded(isName, "must be a provider name"),
    model: (v) => parseModel(v, null),
    default: onlyTrue,
  });
}

export function skill(value: unknown): SkillSpec {
  const spec = optionalSpec<SkillSpec>(value, {
    url: (v) => {
      if (typeof v !== "string" || v === "" || v.length > MAX_SKILL_URL) {
        throw new BadRequest("must be a URL within the length limit");
      }
      if (sourceKind(v) === null) throw new BadRequest("must be http or https");
      return v;
    },
    fromIndex: boolean,
    path: (v) => {
      if (typeof v !== "string" || (v !== "" && !validPath(v))) {
        throw new BadRequest("must be a relative archive path");
      }
      return v;
    },
  });
  if (spec.path !== undefined) {
    if (
      spec.fromIndex ||
      (spec.url !== undefined && sourceKind(spec.url) !== "archive")
    ) {
      throw new Error("spec.path is only for an archive URL");
    }
  }
  if (spec.url !== undefined) {
    const index = sourceKind(spec.url) === "index";
    if (index && spec.fromIndex !== true) {
      throw new Error("spec.fromIndex must be true for an index URL");
    }
    if (!index && spec.fromIndex === true) {
      throw new Error("spec.fromIndex is only for an index URL");
    }
  }
  return spec;
}

export function mcpServer(value: unknown): McpServerSpec {
  return optionalSpec<McpServerSpec>(value, {
    url: parseUrl,
    keyFrom: parseMcpKeyName,
    read: boolean,
    write: boolean,
    instructionsOn: boolean,
    timeoutMs: parseTimeout,
    readPatterns: (v) => parsePatterns(v, "readPatterns"),
    writePatterns: (v) => parsePatterns(v, "writePatterns"),
    excludedPatterns: (v) => parsePatterns(v, "excludedPatterns"),
  });
}

function servers(value: unknown): NonNullable<AgentSpec["servers"]> {
  if (!Array.isArray(value) || value.length > MAX_SERVERS_PER_AGENT) {
    throw new BadRequest(
      `must be an array of at most ${MAX_SERVERS_PER_AGENT} servers`,
    );
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const path = `spec.servers[${index}]`;
    const b = object(item, ["name", "read", "write"], path);
    const name = at(`${path}.name`, () =>
      guarded(isServerName, "is invalid")(b.name),
    );
    if (seen.has(name)) throw new Error(`${path}.name must not repeat`);
    seen.add(name);
    const read = Object.hasOwn(b, "read")
      ? at(`${path}.read`, () => boolean(b.read))
      : true;
    const write = Object.hasOwn(b, "write")
      ? at(`${path}.write`, () => boolean(b.write))
      : false;
    if (!read) throw new Error(`${path} needs read`);
    return { name, read, write };
  });
}

export function agent(value: unknown): AgentSpec {
  return optionalSpec<AgentSpec>(value, {
    provider: guarded(isName, "must be a provider name"),
    model: (v) => parseModel(v, null),
    avatar: (v) => guarded(isAvatar, "must be a known avatar")(v ?? "bot"),
    thinking: (v) => parseThinking(v, null),
    effort: (v) => parseEffort(v, null),
    prompt: (v) => parsePrompt(v, null),
    skills: (v) => names(v ?? [], isSkillName, MAX_SKILLS_PER_AGENT),
    servers,
    mcpMode: guarded(isMcpMode, "must be all, catalog or auto"),
    // the range is the API's to hold
    contextLength: (v) => {
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) {
        throw new BadRequest("must be a whole number of tokens or null");
      }
      return v;
    },
    tools: boolean,
    // the tag's shape is the API's to hold
    upstream: (v) => {
      if (v !== null && (typeof v !== "string" || v === "")) {
        throw new BadRequest("must be an endpoint tag or null");
      }
      return v;
    },
    skip4Bit: boolean,
    default: onlyTrue,
  });
}

export function tool(value: unknown, name: ToolName): ToolSpec {
  const allowed = TOOL_FIELDS[name];
  const spec = optional<ToolSpec>(object(value, allowed, "spec"), {
    mode: guarded(isWebAccessMode, "mode must be off, all or listed"),
    domains: parseWebDomains,
    enabled: boolean,
    provider: (v) => {
      if (v !== null && !isSearchProvider(v)) {
        throw new BadRequest("must be exa, firecrawl, tavily or null");
      }
      return v;
    },
    hosts: parseHosts,
  });
  if (Object.keys(spec).length === 0) {
    throw new Error(
      `${allowed.map((field) => `spec.${field}`).join(" or ")} is required`,
    );
  }
  return spec;
}
