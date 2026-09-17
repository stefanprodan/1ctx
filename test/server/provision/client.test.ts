// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { client, difference } from "../../../src/server/provision/client.ts";

test("the in-process client keeps the login cookie without origin headers", async () => {
  const requests: Request[] = [];
  const api = client(async (request, address) => {
    requests.push(request);
    expect(address).toBe("127.0.0.1");
    if (requests.length === 1) {
      return Response.json(
        { ok: true },
        {
          headers: { "set-cookie": "login=fake-token; HttpOnly; SameSite=Lax" },
        },
      );
    }
    return Response.json({ ok: true });
  });
  await api.call("POST", "/api/login", {
    username: "admin",
    password: "fake-password",
  });
  await api.call("GET", "/api/users");
  expect(requests[0].headers.get("cookie")).toBeNull();
  expect(requests[1].headers.get("cookie")).toBe("login=fake-token");
  for (const request of requests) {
    expect(request.headers.get("origin")).toBeNull();
    expect(request.headers.get("sec-fetch-site")).toBeNull();
  }
});

test("the client keeps the router's refusal words", async () => {
  const api = client(async () =>
    Response.json(
      { error: "the last admin must remain enabled" },
      { status: 409 },
    ),
  );
  await expect(api.call("PATCH", "/api/users/fake-id", {})).rejects.toThrow(
    "the last admin must remain enabled",
  );
});

test("comparisons ignore membership order but not sides or scalar values", () => {
  const before = {
    skills: ["second", "first"],
    servers: [
      { serverId: "two", read: true, write: false },
      { serverId: "one", read: true, write: false },
    ],
    prompt: "Keep the note.",
    thinking: "on",
  };
  expect(
    difference(before, {
      skills: ["first", "second"],
      servers: [
        { write: false, read: true, serverId: "one" },
        { write: false, read: true, serverId: "two" },
      ],
    }),
  ).toEqual({});
  expect(difference(before, { skills: [], thinking: null })).toEqual({
    skills: [],
    thinking: null,
  });
  const servers = [{ serverId: "one", read: true, write: true }];
  expect(difference(before, { servers })).toEqual({ servers });
});
