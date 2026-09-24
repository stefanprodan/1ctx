// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
  MAX_MODEL,
  MAX_PROMPT,
  MAX_SERVERS_PER_AGENT,
} from "../agents/index.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  parseMcpKeyName,
  parsePatterns,
  parseTimeout,
  parseUrl,
} from "../mcp/index.ts";
import { parseBaseUrl, parseKeyName } from "../providers/index.ts";
import { MAX_SKILL_URL, validPath } from "../skills/index.ts";
import { parseHosts, parseWebDomains } from "../tools/index.ts";
import { at, boolean, guarded, names, object, optional } from "./fields.ts";

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
export function folderPath(value: unknown): string {
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

export type ProviderSpec = {
  wire?: Wire;
  baseUrl?: string;
  keyFrom?: string | null;
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
  Project: ProjectSpec;
  Provider: ProviderSpec;
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
  return optional<ProjectSpec>(
    object(value, ["description", "members", "knowledge"], "spec"),
    {
      description: guarded(
        isDescription,
        `must be one trimmed line of at most ${MAX_DESCRIPTION} characters`,
      ),
      members: (v) => names(v, isUsername),
      knowledge: folderPath,
    },
  );
}

export function provider(value: unknown): ProviderSpec {
  return optional<ProviderSpec>(
    object(value, ["wire", "baseUrl", "keyFrom"], "spec"),
    {
      wire: guarded(isWire, "must be a known wire"),
      baseUrl: parseBaseUrl,
      keyFrom: parseKeyName,
    },
  );
}

export function skill(value: unknown): SkillSpec {
  const spec = optional<SkillSpec>(
    object(value, ["url", "fromIndex", "path"], "spec"),
    {
      url: (v) => {
        if (typeof v !== "string" || v === "" || v.length > MAX_SKILL_URL) {
          throw new BadRequest("must be a URL within the length limit");
        }
        if (sourceKind(v) === null)
          throw new BadRequest("must be http or https");
        return v;
      },
      fromIndex: boolean,
      path: (v) => {
        if (typeof v !== "string" || (v !== "" && !validPath(v))) {
          throw new BadRequest("must be a relative archive path");
        }
        return v;
      },
    },
  );
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
  return optional<McpServerSpec>(
    object(
      value,
      [
        "url",
        "keyFrom",
        "read",
        "write",
        "instructionsOn",
        "timeoutMs",
        "readPatterns",
        "writePatterns",
        "excludedPatterns",
      ],
      "spec",
    ),
    {
      url: parseUrl,
      keyFrom: parseMcpKeyName,
      read: boolean,
      write: boolean,
      instructionsOn: boolean,
      timeoutMs: parseTimeout,
      readPatterns: (v) => parsePatterns(v, "readPatterns"),
      writePatterns: (v) => parsePatterns(v, "writePatterns"),
      excludedPatterns: (v) => parsePatterns(v, "excludedPatterns"),
    },
  );
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
    if (!read && !write) throw new Error(`${path} needs read or write`);
    return { name, read, write };
  });
}

export function agent(value: unknown): AgentSpec {
  return optional<AgentSpec>(
    object(
      value,
      [
        "provider",
        "model",
        "avatar",
        "thinking",
        "effort",
        "prompt",
        "skills",
        "servers",
        "mcpMode",
        "contextLength",
        "tools",
      ],
      "spec",
    ),
    {
      provider: guarded(isName, "must be a provider name"),
      model: (v) => {
        if (typeof v !== "string" || v === "" || v.length > MAX_MODEL) {
          throw new BadRequest("must be a model id");
        }
        return v;
      },
      avatar: (v) => guarded(isAvatar, "must be a known avatar")(v ?? "bot"),
      thinking: (v) => {
        if (v !== null && v !== "on" && v !== "off") {
          throw new BadRequest("must be on, off or null");
        }
        return v;
      },
      effort: (v) => {
        if (v !== null && typeof v !== "string") {
          throw new BadRequest("must be text or null");
        }
        return v;
      },
      prompt: (v) => {
        const prompt = v ?? "";
        if (typeof prompt !== "string" || prompt.length > MAX_PROMPT) {
          throw new BadRequest(
            `must be text of at most ${MAX_PROMPT} characters`,
          );
        }
        return prompt.trim();
      },
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
    },
  );
}

export function tool(value: unknown, name: string): ToolSpec {
  const allowed =
    name === "web"
      ? ["mode", "domains"]
      : name === "websearch"
        ? ["provider"]
        : ["enabled", "hosts"];
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
