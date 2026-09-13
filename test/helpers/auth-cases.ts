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
    body: { fullName: "Oana", about: "" },
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
    path: "/api/projects",
    expect: { anonymous: 401, member: 200, admin: 200 },
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
    method: "PATCH",
    path: "/api/tools/:name",
    body: { enabled: true },
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
    path: "/api/usage/week",
    expect: { anonymous: 401, member: 200, admin: 200 },
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
    path: "/api/sessions/:id/messages/:messageId/result",
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
    path: "/api/sessions/:id/regenerate",
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
