// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsResponse } from "../../shared/api/agents.ts";
import type { DirectoryUserResponse } from "../../shared/api/directory.ts";
import type {
  KnowledgeFileDetailResponse,
  KnowledgeListResponse,
} from "../../shared/api/knowledge.ts";
import type { McpResponse, PatchMcpSettings } from "../../shared/api/mcp.ts";
import type {
  ProjectResponse,
  ProjectsResponse,
} from "../../shared/api/projects.ts";
import type { ProvidersResponse } from "../../shared/api/providers.ts";
import type {
  AddSkillRequest,
  DiscoverResponse,
  SkillResponse,
  SkillsResponse,
} from "../../shared/api/skills.ts";
import type { ToolsResponse } from "../../shared/api/tools.ts";
import type { UsersResponse } from "../../shared/api/users.ts";
import type { SecretKind } from "../../shared/words.ts";
import { type Client, difference } from "./client.ts";
import { type Document, KINDS } from "./parse.ts";

export type Action = "created" | "updated" | "unchanged";
export type Counts = Record<Action, number>;
export type Secret = (kind: SecretKind, name: string) => string | null;
type Of<K extends Document["kind"]> = Extract<Document, { kind: K }>;

function idOf(rows: { id: string; name: string }[], name: string): string {
  const row = rows.find((row) => row.name === name);
  if (!row) throw new Error(`no such reference ${name}`);
  return row.id;
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`spec.${field} is required`);
  return value;
}

async function user(
  api: Client,
  doc: Of<"User">,
  secret: Secret,
): Promise<Action> {
  const { users } = await api.call<UsersResponse>("GET", "/api/users");
  const before = users.find((row) => row.username === doc.name);
  const { passwordFrom, mustChangePassword, ...fields } = doc.spec;
  const desired = { ...fields, disabled: fields.disabled ?? false };
  if (!before) {
    const password = secret("user-", required(passwordFrom, "passwordFrom"));
    if (password === null) throw new Error("spec.passwordFrom has no value");
    await api.call("POST", "/api/users", {
      username: doc.name,
      ...desired,
      password,
      ...(mustChangePassword === undefined ? {} : { mustChangePassword }),
    });
    return "created";
  }
  const current =
    fields.about === undefined
      ? before
      : {
          ...before,
          about: (
            await api.call<DirectoryUserResponse>(
              "GET",
              `/api/directory/users/${doc.name}`,
            )
          ).user.about,
        };
  const patch = difference(current, desired);
  if (!Object.keys(patch).length) return "unchanged";
  await api.call("PATCH", `/api/users/${before.id}`, patch);
  return "updated";
}

async function project(
  api: Client,
  doc: Of<"Project">,
): Promise<{ action: Action; id: string }> {
  const { projects } = await api.call<ProjectsResponse>("GET", "/api/projects");
  const before = projects.find(
    (row) => row.kind === "team" && row.name === doc.name,
  );
  const { project } = before
    ? await api.call<ProjectResponse>("GET", `/api/projects/${before.id}`)
    : await api.call<ProjectResponse>("POST", "/api/projects", {
        name: doc.name,
        description: doc.spec.description ?? "",
      });
  let action: Action = before ? "unchanged" : "created";
  if (
    before &&
    doc.spec.description !== undefined &&
    doc.spec.description !== project.description
  ) {
    await api.call("PATCH", `/api/projects/${project.id}`, {
      description: doc.spec.description,
    });
    action = "updated";
  }
  if (doc.spec.members !== undefined) {
    const { users } = await api.call<UsersResponse>("GET", "/api/users");
    const wanted = new Set(
      doc.spec.members.map((name) =>
        idOf(
          users.map((row) => ({ id: row.id, name: row.username })),
          name,
        ),
      ),
    );
    const held = new Set(project.members.map((row) => row.id));
    for (const id of held) {
      if (wanted.has(id)) continue;
      await api.call("DELETE", `/api/projects/${project.id}/members/${id}`);
      if (before) action = "updated";
    }
    for (const userId of wanted) {
      if (held.has(userId)) continue;
      await api.call("POST", `/api/projects/${project.id}/members`, { userId });
      if (before) action = "updated";
    }
  }
  return { action, id: project.id };
}

// The folder wins over a live doc's text and a doc it does not name is
// kept: a replaced text stays in the doc's history, nothing is pruned.
async function docs(
  api: Client,
  doc: Of<"Project">,
  projectId: string,
  report: (action: Action, kind: string, name: string) => void,
): Promise<void> {
  if (doc.docs === undefined) return;
  const base = `/api/projects/${projectId}/knowledge`;
  const { files } = await api.call<KnowledgeListResponse>("GET", base);
  const live = new Map(files.map((file) => [file.name, file.id]));
  for (const file of doc.docs) {
    try {
      const id = live.get(file.name);
      if (id === undefined) {
        await api.call("POST", base, { name: file.name, text: file.text });
        report("created", "Knowledge", `${doc.name}/${file.name}`);
        continue;
      }
      const { file: current } = await api.call<KnowledgeFileDetailResponse>(
        "GET",
        `${base}/files/${id}`,
      );
      if (current.text === file.text) continue;
      await api.call("PUT", `${base}/files/${id}`, {
        text: file.text,
        revision: current.revision,
      });
      report("updated", "Knowledge", `${doc.name}/${file.name}`);
    } catch (error) {
      throw new Error(
        `knowledge ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function provider(api: Client, doc: Of<"Provider">): Promise<Action> {
  const { providers } = await api.call<ProvidersResponse>(
    "GET",
    "/api/providers",
  );
  const before = providers.find((row) => row.name === doc.name);
  const { keyFrom, ...fields } = doc.spec;
  const desired = {
    ...fields,
    ...(keyFrom === undefined ? {} : { keyName: keyFrom }),
  };
  if (before) {
    for (const field of Object.keys(difference(before, desired))) {
      throw new Error(
        `spec.${field === "keyName" ? "keyFrom" : field} cannot be changed`,
      );
    }
    return "unchanged";
  }
  await api.call("POST", "/api/providers", {
    name: doc.name,
    ...desired,
  });
  return "created";
}

async function skill(api: Client, doc: Of<"Skill">): Promise<Action> {
  const { skills } = await api.call<SkillsResponse>("GET", "/api/skills");
  const before = skills.find((row) => row.name === doc.name);
  const spec = doc.spec;
  if (before) {
    if (spec.path !== undefined && before.sourceKind !== "archive") {
      throw new Error("spec.path is only for an archive");
    }
    if (spec.url !== undefined && spec.url !== before.sourceUrl) {
      throw new Error("spec.url cannot be changed");
    }
    if (spec.path !== undefined && spec.path !== before.sourceSelect) {
      throw new Error("spec.path cannot be changed");
    }
    if (
      spec.fromIndex !== undefined &&
      spec.fromIndex !== (before.sourceKind === "index")
    ) {
      throw new Error("spec.fromIndex cannot be changed");
    }
    return "unchanged";
  }
  const url = required(spec.url, "url");
  let body: AddSkillRequest = {
    url,
    ...(spec.path === undefined ? {} : { path: spec.path }),
  };
  if (spec.fromIndex) {
    const found = await api.call<DiscoverResponse>(
      "POST",
      "/api/skills/discover",
      {
        url,
      },
    );
    const entry = found.entries.find((entry) => entry.name === doc.name);
    if (!entry) throw new Error(`spec.url does not list ${doc.name}`);
    body = { url, name: doc.name, digest: entry.digest };
  }
  const added = await api.call<SkillResponse>("POST", "/api/skills", body);
  if (added.skill.name !== doc.name) {
    throw new Error(
      `metadata.name asserts ${doc.name}, but spec.url holds ${added.skill.name}`,
    );
  }
  return "created";
}

async function mcp(api: Client, doc: Of<"McpServer">): Promise<Action> {
  const { servers } = await api.call<McpResponse>("GET", "/api/mcp");
  const before = servers.find((row) => row.name === doc.name);
  const { url, keyFrom, ...settings } = doc.spec;
  const endpoint = {
    ...(url === undefined ? {} : { url }),
    ...(keyFrom === undefined ? {} : { keyName: keyFrom }),
  };
  if (!before) {
    await api.call("POST", "/api/mcp", {
      name: doc.name,
      url,
      keyName: keyFrom ?? null,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: [],
      writePatterns: [],
      excludedPatterns: [],
      ...settings,
    });
    return "created";
  }
  const endpointPatch = difference(before, endpoint);
  const settingsPatch: PatchMcpSettings = difference(before, settings);
  const changedEndpoint = Object.keys(endpointPatch).length > 0;
  const changedSettings = Object.keys(settingsPatch).length > 0;
  if (changedEndpoint) {
    await api.call("PATCH", `/api/mcp/${before.id}`, endpointPatch);
  }
  if (changedSettings) {
    await api.call("PATCH", `/api/mcp/${before.id}`, settingsPatch);
  }
  return changedEndpoint || changedSettings ? "updated" : "unchanged";
}

async function agent(api: Client, doc: Of<"Agent">): Promise<Action> {
  const { agents } = await api.call<AgentsResponse>("GET", "/api/agents");
  const before = agents.find((row) => row.name === doc.name);
  const { provider, skills, servers, ...fields } = doc.spec;
  const { providers } = await api.call<ProvidersResponse>(
    "GET",
    "/api/providers",
  );
  const providerId =
    provider === undefined
      ? required(before?.providerId, "provider")
      : idOf(providers, provider);
  let savedSkills = before?.skills ?? [];
  if (skills !== undefined) {
    const found = await api.call<SkillsResponse>("GET", "/api/skills");
    savedSkills = skills.map((name) => idOf(found.skills, name));
  }
  let savedServers = before?.servers ?? [];
  if (servers !== undefined) {
    const found = await api.call<McpResponse>("GET", "/api/mcp");
    savedServers = servers.map(({ name, read, write }) => ({
      serverId: idOf(found.servers, name),
      read,
      write,
    }));
  }
  // what an admin stated for a model its catalog does not describe
  // stays while the model does, as an omitted field stays
  const keep = (row: typeof before) =>
    row &&
    !row.model.described &&
    (fields.model ?? row.model.id) === row.model.id
      ? { contextLength: row.model.contextLength, tools: row.model.tools }
      : {};
  const desired = {
    name: doc.name,
    providerId,
    model: before?.model.id,
    avatar: before?.avatar ?? "bot",
    thinking: before?.thinking ?? null,
    effort: before?.effort ?? null,
    prompt: before?.prompt ?? "",
    mcpMode: before?.mcpMode ?? "auto",
    ...keep(before),
    ...fields,
    skills: savedSkills,
    servers: savedServers,
  };
  if (
    before &&
    !Object.keys(
      difference(
        { ...before, model: before.model.id, ...keep(before) },
        desired,
      ),
    ).length
  ) {
    return "unchanged";
  }
  await api.call(
    before ? "PATCH" : "POST",
    before ? `/api/agents/${before.id}` : "/api/agents",
    desired,
  );
  return before ? "updated" : "created";
}

async function tool(api: Client, doc: Of<"Tool">): Promise<Action> {
  const found = await api.call<ToolsResponse>("GET", "/api/tools");
  const before =
    doc.name === "web"
      ? found.access
      : doc.name === "websearch"
        ? found.search
        : doc.name === "visualize"
          ? found.visualize
          : null;
  if (!before) throw new Error("no such tool");
  const patch = difference(before, doc.spec);
  if (!Object.keys(patch).length) return "unchanged";
  await api.call("PATCH", `/api/tools/${doc.name}`, patch);
  return "updated";
}

export async function apply(
  api: Client,
  documents: Document[],
  secret: Secret,
  report: (action: Action, kind: string, name: string) => void,
) {
  for (const kind of KINDS) {
    for (const doc of documents.filter((doc) => doc.kind === kind)) {
      try {
        let action: Action;
        switch (doc.kind) {
          case "User":
            action = await user(api, doc, secret);
            break;
          case "Project": {
            const made = await project(api, doc);
            report(made.action, doc.kind, doc.name);
            await docs(api, doc, made.id, report);
            continue;
          }
          case "Provider":
            action = await provider(api, doc);
            break;
          case "Skill":
            action = await skill(api, doc);
            break;
          case "McpServer":
            action = await mcp(api, doc);
            break;
          case "Agent":
            action = await agent(api, doc);
            break;
          case "Tool":
            action = await tool(api, doc);
            break;
        }
        report(action, doc.kind, doc.name);
      } catch (error) {
        throw new Error(
          `${doc.source}: ${doc.kind}/${doc.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
