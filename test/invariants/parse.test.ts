// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every request parser refuses a malformed body and an unknown field.

import { describe, expect, test } from "bun:test";
import {
  parseEmail,
  parseLogin,
  parseNewUser,
  parsePasswordChange,
  parseProfile,
  parseUsername,
  parseUserPassword,
  parseUserPatch,
} from "../../src/server/access/parse.ts";
import { BadRequest } from "../../src/server/lib/errors.ts";
import {
  parseCreateSession,
  parseRenameSession,
  parseSendMessage,
  parseStreamQuery,
  titleFrom,
} from "../../src/server/sessions/parse.ts";
import {
  isEmail,
  isName,
  isUsername,
  MAX_MESSAGE_BYTES,
  MAX_SEARCH,
  MAX_TITLE,
  shapeName,
} from "../../src/shared/words.ts";
import { testApp } from "../helpers/app.ts";
import { refuses } from "../helpers/refuses.ts";

describe("parseLogin", () => {
  test("accepts a username and a password", () => {
    expect(parseLogin({ username: "casey", password: "pw" })).toEqual({
      username: "casey",
      password: "pw",
    });
  });

  refuses(
    [
      null,
      "string",
      [],
      {},
      { username: "casey" },
      { password: "pw" },
      { username: "", password: "pw" },
      { username: "casey", password: "" },
      { username: 1, password: "pw" },
      { username: "casey", password: { $ne: "" } },
      { username: "casey", password: "pw", role: "admin" },
      { username: "a".repeat(33), password: "pw" },
      { username: "casey", password: "p".repeat(1025) },
    ],
    parseLogin,
  );
});

describe("the name rule", () => {
  test.each(["on-call", "on_call", "q3", "1ctx", "a".repeat(80)])(
    "a name may be %s",
    (v) => {
      expect(isName(v)).toBe(true);
    },
  );

  test.each([
    "a",
    "a".repeat(81),
    "On-call",
    "on.call",
    "on call",
    "-on-call",
    "_on-call",
    "ops\u00e9",
    "",
    1,
  ])("a name may not be %p", (v) => {
    expect(isName(v)).toBe(false);
  });

  test("a username is a name with its own length", () => {
    expect(isUsername("casey_d")).toBe(true);
    expect(isUsername("a".repeat(32))).toBe(true);
    expect(isUsername("ab")).toBe(false);
    expect(isUsername("a".repeat(33))).toBe(false);
    expect(isUsername("casey.d")).toBe(false);
  });

  test("a name field lowercases and dashes spaces and dots as typed", () => {
    expect(shapeName("Q3 Launch")).toBe("q3-launch");
    expect(shapeName("stefan.prodan")).toBe("stefan-prodan");
    expect(shapeName("on_call")).toBe("on_call");
    expect(shapeName("ops@home")).toBe("ops@home");
  });
});

describe("parseUsername", () => {
  test.each(["casey", "casey_p", "a-1_2", "123"])("accepts %s", (v) => {
    expect(parseUsername(v)).toBe(v);
  });

  refuses(
    [
      "",
      "ab",
      "Casey",
      "oa na",
      "casey.p",
      ".casey",
      "casey@x",
      "a".repeat(33),
      1,
    ],
    parseUsername,
  );
});

describe("parseEmail", () => {
  test.each(["a@b.co", "name@example.com", "A@B.CO"])("accepts %s", (value) => {
    expect(isEmail(value)).toBe(true);
  });

  test("lowercases an accepted address", () => {
    expect(parseEmail("Casey@Example.COM")).toBe("casey@example.com");
  });

  test.each([
    "a@b",
    " a@b.co",
    "a b@c.co",
    "a@b.c",
    "a@.co",
    "a@b..co",
    "@b.co",
    "a@@b.co",
    `${"a".repeat(250)}@b.co`,
  ])("refuses %p", (value) => {
    expect(isEmail(value)).toBe(false);
    expect(() => parseEmail(value)).toThrow(BadRequest);
  });
});

describe("parseProfile", () => {
  test("accepts a full name, an about text and a zone", () => {
    const body = {
      fullName: "Casey Doe",
      about: "Actor.\nBucharest.",
      tz: "Europe/Bucharest",
    };
    expect(parseProfile(body)).toEqual(body);
    expect(parseProfile({ ...body, tz: "UTC" }).tz).toBe("UTC");
  });

  refuses(
    [
      {},
      { fullName: "Casey" },
      { fullName: "Casey", about: "" },
      { fullName: "Casey", about: "", tz: "" },
      { fullName: "Casey", about: "", tz: "Mars/Olympus" },
      { fullName: "Casey", about: "", tz: 3 },
      { fullName: "Casey", about: "", tz: "a".repeat(65) },
      { fullName: "", about: "", tz: "UTC" },
      { fullName: " Casey", about: "", tz: "UTC" },
      { fullName: "Casey\nP", about: "", tz: "UTC" },
      { fullName: "Casey\u2028P", about: "", tz: "UTC" },
      { fullName: "a".repeat(65), about: "", tz: "UTC" },
      { fullName: "Casey", about: "", tz: "UTC", username: "casey" },
      { fullName: 1, about: "", tz: "UTC" },
      { fullName: "Casey", about: 1, tz: "UTC" },
      { fullName: "Casey", about: "a".repeat(2001), tz: "UTC" },
    ],
    parseProfile,
  );
});

describe("parsePasswordChange", () => {
  test("accepts a current and a long enough next", () => {
    expect(parsePasswordChange({ current: "pw", next: "longenough" })).toEqual({
      current: "pw",
      next: "longenough",
    });
  });

  refuses(
    [
      {},
      { current: "pw" },
      { next: "longenough" },
      { current: "", next: "longenough" },
      { current: "pw", next: "short" },
      { current: "pw", next: "x".repeat(1025) },
      { current: "pw", next: "longenough", again: "longenough" },
    ],
    parsePasswordChange,
  );
});

describe("parseNewUser", () => {
  const body = {
    username: "casey",
    fullName: "Casey Doe",
    email: "CASEY@EXAMPLE.COM",
    role: "member" as const,
    tz: "Europe/Bucharest",
    password: "longenough",
  };

  test("accepts every required field and lowercases the email", () => {
    expect(parseNewUser(body)).toEqual({
      ...body,
      email: "casey@example.com",
    });
  });

  test.each([false, true])("accepts optional fields with %p flags", (flag) => {
    expect(
      parseNewUser({
        ...body,
        about: "First line.\nSecond line.",
        disabled: flag,
        mustChangePassword: flag,
      }),
    ).toEqual({
      ...body,
      email: "casey@example.com",
      about: "First line.\nSecond line.",
      disabled: flag,
      mustChangePassword: flag,
    });
  });

  refuses(
    [
      {},
      { ...body, username: undefined },
      { ...body, fullName: undefined },
      { ...body, email: "a@b" },
      { ...body, role: "owner" },
      { ...body, tz: undefined },
      { ...body, tz: "Mars/Olympus" },
      { ...body, password: "short" },
      { ...body, about: null },
      { ...body, about: false },
      { ...body, about: 1 },
      { ...body, about: [] },
      { ...body, about: {} },
      { ...body, about: "a".repeat(2001) },
      ...[null, "false", 0, [], {}].map((disabled) => ({
        ...body,
        disabled,
      })),
      ...[null, "false", 0, [], {}].map((mustChangePassword) => ({
        ...body,
        mustChangePassword,
      })),
      { ...body, extra: true },
    ],
    parseNewUser,
  );
});

describe("parseUserPatch", () => {
  test("accepts any supplied field and lowercases the email", () => {
    expect(parseUserPatch({ username: "maria" })).toEqual({
      username: "maria",
    });
    expect(
      parseUserPatch({
        fullName: "Maria Popescu",
        about: "First line.\nSecond line.",
        email: "MARIA@EXAMPLE.COM",
        role: "admin",
        tz: "Asia/Tokyo",
        disabled: true,
      }),
    ).toEqual({
      fullName: "Maria Popescu",
      about: "First line.\nSecond line.",
      email: "maria@example.com",
      role: "admin",
      tz: "Asia/Tokyo",
      disabled: true,
    });
  });

  test("accepts clearing about without a full name", () => {
    expect(parseUserPatch({ about: "" })).toEqual({ about: "" });
  });

  refuses(
    [
      {},
      { username: "no" },
      { fullName: "" },
      { about: null },
      { about: 1 },
      { about: false },
      { about: [] },
      { about: {} },
      { about: "a".repeat(2001) },
      { email: "a@b" },
      { role: "owner" },
      { tz: "" },
      { tz: "Mars/Olympus" },
      { disabled: 1 },
      { disabled: "true" },
      { disabled: null },
      { password: "longenough" },
      { mustChangePassword: false },
      { mustChangePassword: true },
      { email: "a@b.co", extra: true },
    ],
    parseUserPatch,
  );
});

describe("parseUserPassword", () => {
  test("accepts a password at the floor", () => {
    expect(parseUserPassword({ password: "12345678" })).toEqual({
      password: "12345678",
    });
  });

  refuses(
    [
      {},
      { password: "short" },
      { password: "x".repeat(1025) },
      { password: "longenough", current: "old" },
    ],
    parseUserPassword,
  );
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

  refuses(
    [
      null,
      "string",
      [],
      {},
      { projectId: "p1", agentId: "a1" },
      { projectId: "p1", message: "hi" },
      { agentId: "a1", message: "hi" },
      { projectId: "", agentId: "a1", message: "hi" },
      { projectId: 1, agentId: "a1", message: "hi" },
      { projectId: "p1", agentId: "", message: "hi" },
      { projectId: "p1", agentId: 1, message: "hi" },
      { projectId: "p1", agentId: "a1", message: "" },
      { projectId: "p1", agentId: "a1", message: "  \n " },
      { projectId: "p1", agentId: "a1", message: 1 },
      { projectId: "p1", agentId: "a1", message: "hi", extra: true },
      {
        projectId: "p1",
        agentId: "a1",
        message: "x".repeat(MAX_MESSAGE_BYTES + 1),
      },
    ],
    parseCreateSession,
  );
});

describe("parseSendMessage", () => {
  test("accepts a message and preserves its whitespace", () => {
    expect(parseSendMessage({ message: " hi " })).toEqual({ message: " hi " });
  });

  refuses(
    [
      null,
      "string",
      [],
      {},
      { message: "" },
      { message: " \t\n" },
      { message: 1 },
      { message: "hi", extra: true },
      { message: "x".repeat(MAX_MESSAGE_BYTES + 1) },
    ],
    parseSendMessage,
  );
});

describe("parseRenameSession", () => {
  test("keeps the title as typed, trimmed at the ends", () => {
    expect(parseRenameSession({ title: "  My Chat, As Typed  " })).toEqual({
      title: "My Chat, As Typed",
    });
    expect(parseRenameSession({ title: "x".repeat(MAX_TITLE) })).toEqual({
      title: "x".repeat(MAX_TITLE),
    });
  });

  refuses(
    [
      null,
      {},
      { title: "" },
      { title: "  \n " },
      { title: 1 },
      { title: "two\nlines" },
      { title: "two\vlines" },
      { title: "two\u2028lines" },
      { title: "x".repeat(MAX_TITLE + 1) },
      { title: "ok", extra: true },
    ],
    parseRenameSession,
  );
});

describe("parseStreamQuery", () => {
  test.each([
    ["http://one.test/api/sessions", { project: null, q: "", origin: null }],
    [
      "http://one.test/api/sessions?project=",
      { project: null, q: "", origin: null },
    ],
    [
      "http://one.test/api/sessions?project=p1&q=%20Alpha%20",
      { project: "p1", q: "Alpha", origin: null },
    ],
    [
      "http://one.test/api/sessions?origin=automation",
      { project: null, q: "", origin: "automation" as const },
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
