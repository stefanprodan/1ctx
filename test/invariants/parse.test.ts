// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every request parser refuses a malformed body and an unknown field.

import { describe, expect, test } from "bun:test";
import {
  parseLogin,
  parsePasswordChange,
  parseProfile,
  parseUsername,
} from "../../src/server/access/parse.ts";
import { BadRequest } from "../../src/server/lib/errors.ts";
import {
  parseCreateSession,
  parseSendMessage,
  parseStreamQuery,
  titleFrom,
} from "../../src/server/sessions/parse.ts";
import {
  MAX_MESSAGE_BYTES,
  MAX_SEARCH,
  MAX_TITLE,
} from "../../src/shared/words.ts";
import { testApp } from "../helpers/app.ts";

describe("parseLogin", () => {
  test("accepts a username and a password", () => {
    expect(parseLogin({ username: "oana", password: "pw" })).toEqual({
      username: "oana",
      password: "pw",
    });
  });

  test.each([
    [null],
    ["string"],
    [[]],
    [{}],
    [{ username: "oana" }],
    [{ password: "pw" }],
    [{ username: "", password: "pw" }],
    [{ username: "oana", password: "" }],
    [{ username: 1, password: "pw" }],
    [{ username: "oana", password: { $ne: "" } }],
    [{ username: "oana", password: "pw", role: "admin" }],
    [{ username: "a".repeat(33), password: "pw" }],
    [{ username: "oana", password: "p".repeat(1025) }],
  ])("refuses %p", (body) => {
    expect(() => parseLogin(body)).toThrow(BadRequest);
  });
});

describe("parseUsername", () => {
  test.each(["oana", "oana.p", "a-1_2", "123"])("accepts %s", (v) => {
    expect(parseUsername(v)).toBe(v);
  });

  test.each(["", "ab", "Oana", "oa na", ".oana", "oana@x", "a".repeat(33), 1])(
    "refuses %p",
    (v) => {
      expect(() => parseUsername(v)).toThrow(BadRequest);
    },
  );
});

describe("parseProfile", () => {
  test("accepts a full name and an about text", () => {
    expect(
      parseProfile({ fullName: "Oana Pellea", about: "Actor.\nBucharest." }),
    ).toEqual({ fullName: "Oana Pellea", about: "Actor.\nBucharest." });
  });

  test.each([
    [{}],
    [{ fullName: "Oana" }],
    [{ fullName: "", about: "" }],
    [{ fullName: " Oana", about: "" }],
    [{ fullName: "Oana\nP", about: "" }],
    [{ fullName: "Oana\u2028P", about: "" }],
    [{ fullName: "a".repeat(65), about: "" }],
    [{ fullName: "Oana", about: "", username: "oana" }],
    [{ fullName: 1, about: "" }],
    [{ fullName: "Oana", about: 1 }],
    [{ fullName: "Oana", about: "a".repeat(2001) }],
  ])("refuses %p", (body) => {
    expect(() => parseProfile(body)).toThrow(BadRequest);
  });
});

describe("parsePasswordChange", () => {
  test("accepts a current and a long enough next", () => {
    expect(parsePasswordChange({ current: "pw", next: "longenough" })).toEqual({
      current: "pw",
      next: "longenough",
    });
  });

  test.each([
    [{}],
    [{ current: "pw" }],
    [{ next: "longenough" }],
    [{ current: "", next: "longenough" }],
    [{ current: "pw", next: "short" }],
    [{ current: "pw", next: "x".repeat(1025) }],
    [{ current: "pw", next: "longenough", again: "longenough" }],
  ])("refuses %p", (body) => {
    expect(() => parsePasswordChange(body)).toThrow(BadRequest);
  });
});

describe("over the wire", () => {
  test("a non-JSON body is a 400, not a crash", async () => {
    const app = await testApp();
    const res = await app.client().call("POST", "/api/login", {
      headers: { "content-type": "application/json" },
      body: undefined,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });

  test("an unknown field is a 400 with its name", async () => {
    const app = await testApp();
    const res = await app.client().call("POST", "/api/login", {
      body: { username: "admin", password: "hunter2-test", remember: true },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown field remember" });
  });

  test("an unknown path is 404 and a wrong method 405", async () => {
    const app = await testApp();
    expect((await app.client().call("GET", "/api/nothing")).status).toBe(404);
    expect((await app.client().call("DELETE", "/api/me")).status).toBe(405);
  });
});

describe("parseCreateSession", () => {
  test("accepts project, agent and message fields", () => {
    expect(
      parseCreateSession({ projectId: "p1", agentId: "a1", message: " hi " }),
    ).toEqual({ projectId: "p1", agentId: "a1", message: " hi " });
  });

  test.each([
    [null],
    ["string"],
    [[]],
    [{}],
    [{ projectId: "p1", agentId: "a1" }],
    [{ projectId: "p1", message: "hi" }],
    [{ agentId: "a1", message: "hi" }],
    [{ projectId: "", agentId: "a1", message: "hi" }],
    [{ projectId: 1, agentId: "a1", message: "hi" }],
    [{ projectId: "p1", agentId: "", message: "hi" }],
    [{ projectId: "p1", agentId: 1, message: "hi" }],
    [{ projectId: "p1", agentId: "a1", message: "" }],
    [{ projectId: "p1", agentId: "a1", message: "  \n " }],
    [{ projectId: "p1", agentId: "a1", message: 1 }],
    [{ projectId: "p1", agentId: "a1", message: "hi", extra: true }],
    [
      {
        projectId: "p1",
        agentId: "a1",
        message: "x".repeat(MAX_MESSAGE_BYTES + 1),
      },
    ],
  ])("refuses %p", (body) => {
    expect(() => parseCreateSession(body)).toThrow(BadRequest);
  });
});

describe("parseSendMessage", () => {
  test("accepts a message and preserves its whitespace", () => {
    expect(parseSendMessage({ message: " hi " })).toEqual({ message: " hi " });
  });

  test.each([
    [null],
    ["string"],
    [[]],
    [{}],
    [{ message: "" }],
    [{ message: " \t\n" }],
    [{ message: 1 }],
    [{ message: "hi", extra: true }],
    [{ message: "x".repeat(MAX_MESSAGE_BYTES + 1) }],
  ])("refuses %p", (body) => {
    expect(() => parseSendMessage(body)).toThrow(BadRequest);
  });
});

describe("parseStreamQuery", () => {
  test.each([
    ["http://one.test/api/sessions", { project: null, q: "" }],
    ["http://one.test/api/sessions?project=", { project: null, q: "" }],
    [
      "http://one.test/api/sessions?project=p1&q=%20Alpha%20",
      { project: "p1", q: "Alpha" },
    ],
  ])("accepts %s", (input, expected) => {
    expect(parseStreamQuery(new URL(input))).toEqual(expected);
  });

  test("refuses a query over the search cap", () => {
    const url = new URL("http://one.test/api/sessions");
    url.searchParams.set("q", "x".repeat(MAX_SEARCH + 1));
    expect(() => parseStreamQuery(url)).toThrow(BadRequest);
  });

  test.each([
    "http://one.test/api/sessions?other=x",
    "http://one.test/api/sessions?project=p1&project=p2",
    "http://one.test/api/sessions?q=one&q=two",
  ])("refuses unknown or duplicated parameters in %s", (input) => {
    expect(() => parseStreamQuery(new URL(input))).toThrow(BadRequest);
  });
});

describe("titleFrom", () => {
  test.each([
    [" hello ", "hello"],
    ["  first line  \nsecond line", "first line"],
    ["\nsecond line", "second line"],
    ["", ""],
    ["a".repeat(MAX_TITLE), "a".repeat(MAX_TITLE)],
    ["a".repeat(MAX_TITLE + 1), `${"a".repeat(MAX_TITLE - 1)}…`],
  ])("turns %p into %p", (input, expected) => {
    expect(titleFrom(input)).toBe(expected);
  });
});
