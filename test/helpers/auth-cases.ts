// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The authorization matrix: for every route descriptor, what each kind
// of caller gets. The access suite fails when a route has no entry, so a
// new route cannot land without saying who may call it.

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
    body: { name: "nobody", password: "wrong" },
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
    path: "/api/health",
    expect: { anonymous: 200, member: 200, admin: 200 },
  },
];
