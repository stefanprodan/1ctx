// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The authorization matrix: for every route descriptor, what each kind
// of caller gets. The access suite fails when a route has no entry, so a
// new route cannot land without saying who may call it.

import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";

export type Caller = "anonymous" | "member" | "admin";

export type AuthCase = {
  method: string;
  path: string;
  // a body that passes the parser, so a denial is about access alone
  body?: unknown;
  expect: Record<Caller, number>;
};

export const AUTH_CASES: AuthCase[] = [
  {
    method: "POST",
    path: "/api/projects/:id/uploads",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/uploads",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/uploads/:uploadId",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/login",
    body: { username: "nobody", password: "wrong" },
    // public: everyone reaches the handler; the wrong password is a 401
    // from it, not from the router
    expect: { anonymous: 401, member: 401, admin: 401 },
  },
  {
    method: "POST",
    path: "/api/logout",
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "GET",
    path: "/api/me",
    // public: anonymous gets { user: null }
    expect: { anonymous: 200, member: 200, admin: 200 },
  },
  {
    method: "GET",
    path: "/api/profile",
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "PATCH",
    path: "/api/profile",
    body: { fullName: "Casey", about: "", tz: "UTC" },
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "PATCH",
    path: "/api/profile/project",
    body: { description: "" },
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/profile/password",
    // authenticated: the handler then checks the current password,
    // which this body gets wrong on purpose, and that is a 403 so the
    // client does not take it for a lost login
    body: { current: "nope", next: "longenough" },
    expect: { anonymous: 401, member: 403, admin: 403 },
  },
  {
    method: "GET",
    path: "/api/users",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/users",
    body: {
      username: "maria",
      fullName: "Maria",
      email: "maria@example.com",
      role: "member",
      tz: "UTC",
      password: "longenough",
    },
    expect: { anonymous: 401, member: 403, admin: 201 },
  },
  {
    method: "PATCH",
    path: "/api/users/:id",
    body: { fullName: "Maria" },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/users/:id/password",
    body: { password: "longenough" },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects",
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/projects",
    body: { name: "matrix-team" },
    expect: { anonymous: 401, member: 403, admin: 201 },
  },
  {
    method: "PATCH",
    path: "/api/projects/:id",
    body: { name: "matrix-team" },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/projects/:id/members",
    body: { userId: "none" },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/members/:userId",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    // the literal ":id" names no project, and a project the caller may
    // not see answers the same 404
    method: "GET",
    path: "/api/projects/:id",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/tools",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "GET",
    path: "/api/visual",
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    method: "PATCH",
    path: "/api/tools/:name",
    body: { mode: "all" },
    expect: { anonymous: 401, member: 403, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/limits",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "PUT",
    path: "/api/limits",
    body: { values: DEFAULT_LIMITS },
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "DELETE",
    path: "/api/limits",
    expect: { anonymous: 401, member: 403, admin: 204 },
  },
  {
    method: "GET",
    path: "/api/providers",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/providers",
    body: {
      name: "local",
      wire: "openai-compatible",
      baseUrl: "http://models.test/v1",
      keyName: null,
    },
    expect: { anonymous: 401, member: 403, admin: 201 },
  },
  {
    method: "DELETE",
    path: "/api/providers/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/providers/:id/catalog",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/providers/:id/endpoints",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/agents",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/agents",
    body: {
      name: "coder",
      providerId: "none",
      model: "x",
      thinking: null,
      effort: null,
      servers: [],
      mcpMode: "auto",
    },
    expect: { anonymous: 401, member: 403, admin: 400 },
  },
  {
    method: "PATCH",
    path: "/api/agents/:id",
    body: {
      name: "coder",
      providerId: "none",
      model: "x",
      thinking: null,
      effort: null,
      servers: [],
      mcpMode: "auto",
    },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/agents/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/admin/overview",
    expect: { anonymous: 401, member: 403, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/admin/load",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "GET",
    path: "/api/admin/storage",
    expect: { anonymous: 401, member: 403, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/usage/days",
    expect: { anonymous: 401, member: 400, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/usage/week",
    expect: { anonymous: 401, member: 400, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/memory",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PUT",
    path: "/api/projects/:id/memory",
    body: { entries: [], revision: 0 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/projects/:id/memory/undo",
    body: { revision: 0 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/knowledge",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/projects/:id/knowledge",
    body: { name: "docs/x.md", text: "text" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/projects/:id/knowledge/upload",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/knowledge/files/:fileId",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PUT",
    path: "/api/projects/:id/knowledge/files/:fileId",
    body: { text: "text", revision: 1 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/knowledge/files/:fileId",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PATCH",
    path: "/api/projects/:id/knowledge/files/:fileId",
    body: { name: "docs/y.md", revision: 1 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/knowledge/search",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/knowledge/deleted",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/knowledge/files/:fileId/versions",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/knowledge/versions/:versionId",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/automations",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/automations/preview",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/projects/:id/automations",
    body: {
      name: "daily-run",
      agentId: "none",
      instructions: "check",
      schedule: "0 9 * * *",
      tz: "UTC",
      deadlineMs: null,
      retentionDays: 30,
      ownMemory: false,
    },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/automations/:id",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/automations/:id/memory",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PUT",
    path: "/api/automations/:id/memory",
    body: { entries: [], revision: 0 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/automations/:id/memory/undo",
    body: { revision: 0 },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PATCH",
    path: "/api/automations/:id",
    body: { instructions: "check again" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/automations/:id/suspend",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/automations/:id/resume",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/automations/:id/run",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/automations/:id",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/automations/:id/runs",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/credentials",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/credentials",
    body: {
      name: "quotes",
      keyName: "http-quotes",
      prefix: "https://api.example.test/v1/",
      header: "X-Api-Key",
      template: "{key}",
    },
    expect: { anonymous: 401, member: 403, admin: 201 },
  },
  {
    method: "PATCH",
    path: "/api/credentials/:id",
    body: { methods: ["GET"] },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/credentials/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/mcp",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/mcp",
    // the fake fetch fails every host but the provider's, so discovery
    // is the admin's 502
    body: {
      name: "flux",
      url: "http://mcp.test/mcp",
      keyName: null,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: [],
      writePatterns: [],
      excludedPatterns: [],
    },
    expect: { anonymous: 401, member: 403, admin: 502 },
  },
  {
    method: "PATCH",
    path: "/api/mcp/:id",
    body: { read: true },
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/mcp/:id/refresh",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/mcp/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/skills",
    expect: { anonymous: 401, member: 403, admin: 200 },
  },
  {
    method: "POST",
    path: "/api/skills/discover",
    body: { url: "http://skills.test" },
    expect: { anonymous: 401, member: 403, admin: 502 },
  },
  {
    method: "POST",
    path: "/api/skills",
    body: { url: "http://skills.test/SKILL.md" },
    expect: { anonymous: 401, member: 403, admin: 502 },
  },
  {
    method: "GET",
    path: "/api/skills/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/skills/:id/file",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/skills/:id/refresh",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/skills/:id",
    expect: { anonymous: 401, member: 403, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions",
    expect: { anonymous: 401, member: 200, admin: 200 },
  },
  {
    // the parser passes and the project is not there, or not theirs
    method: "POST",
    path: "/api/sessions",
    body: { projectId: "none", agentId: "none", message: "hi" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions/:id",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/markdown",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/messages/:messageId/result",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/messages/:messageId/files/:index",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/messages/:messageId/calls/:index/visual",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "PATCH",
    path: "/api/sessions/:id",
    body: { title: "renamed" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "DELETE",
    path: "/api/sessions/:id",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/messages",
    body: { message: "hi" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/fork",
    body: { messageId: "aaaaaaaaaaaa", agentId: "none" },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/regenerate",
    body: { capabilities: { disable: ["web"] } },
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/compact",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/stop",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/projects/:id/agents",
    expect: { anonymous: 401, member: 404, admin: 404 },
  },
  {
    method: "GET",
    path: "/api/directory/users/:username",
    // the pattern's own ":" breaks the name rule: the parser's 400
    expect: { anonymous: 401, member: 400, admin: 400 },
  },
  {
    method: "GET",
    path: "/api/directory/agents/:name",
    // the pattern's own ":" breaks the name rule: the parser's 400
    expect: { anonymous: 401, member: 400, admin: 400 },
  },
  {
    // authenticated, and without the upgrade a signed-in caller gets
    // told to upgrade
    method: "GET",
    path: "/api/socket",
    expect: { anonymous: 401, member: 426, admin: 426 },
  },
  {
    method: "GET",
    path: "/api/health",
    expect: { anonymous: 200, member: 200, admin: 200 },
  },
];
