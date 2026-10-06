// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The SMTP settings' parser and the area's pure rules: the public
// address, the header values refused, the backoff and the links.

import { describe, expect, test } from "bun:test";
import { parseSmtp } from "../../../src/server/email/parse.ts";
import {
  BACKOFF_MS,
  hasControl,
  linkOf,
  messageIdOf,
  publicOrigin,
  retryAt,
} from "../../../src/server/email/rules.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";

const valid = {
  host: "SMTP.Example.test",
  port: 465,
  security: "tls",
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "Noreply@Example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test/",
};

const refused = (body: unknown, words: string) => {
  expect(() => parseSmtp(body)).toThrow(BadRequest);
  expect(() => parseSmtp(body)).toThrow(words);
};

describe("the SMTP settings parser", () => {
  test("keeps the origin and lowercases the host and the sender", () => {
    expect(parseSmtp(valid)).toEqual({
      ...valid,
      host: "smtp.example.test",
      security: "tls",
      fromAddress: "noreply@example.test",
      publicAddress: "https://1ctx.example.test",
    });
    expect(
      parseSmtp({ ...valid, username: null, keyName: null }),
    ).toMatchObject({ username: null, keyName: null });
  });

  test("names the field it refuses", () => {
    refused({ ...valid, extra: 1 }, "unknown field extra");
    const { host: _, ...noHost } = valid;
    refused(noHost, "host is required");
    refused({ ...valid, host: "smtp.example.test/x" }, "host must be");
    refused({ ...valid, host: "a b" }, "host must be");
    refused({ ...valid, port: 0 }, "port must be 1 to 65535");
    refused({ ...valid, port: 65536 }, "port must be 1 to 65535");
    refused({ ...valid, port: "465" }, "port must be 1 to 65535");
    refused({ ...valid, security: "ssl" }, "security must be tls or starttls");
    refused({ ...valid, username: "" }, "username must be");
    refused({ ...valid, username: "a\r\nb" }, "username must be");
    refused({ ...valid, keyName: "mcp-relay" }, "keyName must be email-");
    refused({ ...valid, fromAddress: "nobody" }, "fromAddress must be");
    refused({ ...valid, fromName: "1ctx\nBcc: x" }, "fromName must be");
    refused({ ...valid, fromName: " 1ctx" }, "fromName must be");
    refused({ ...valid, publicAddress: "ftp://x.test" }, "publicAddress");
  });

  test("takes a login whole or not at all", () => {
    refused({ ...valid, keyName: null }, "keyName is required with a username");
    refused(
      { ...valid, username: null },
      "username is required with a keyName",
    );
  });
});

describe("the public address", () => {
  test("is an https origin, or http on a loopback host", () => {
    for (const [value, origin] of [
      ["https://1ctx.example.test", "https://1ctx.example.test"],
      ["https://1ctx.example.test:8443/", "https://1ctx.example.test:8443"],
      ["http://127.0.0.1:1236", "http://127.0.0.1:1236"],
      ["http://localhost:1236/", "http://localhost:1236"],
      ["http://[::1]:1236", "http://[::1]:1236"],
    ]) {
      expect(publicOrigin(value!)).toEqual({ ok: true, origin: origin! });
    }
  });

  test("refuses plain http elsewhere, a path, a query and user info", () => {
    for (const value of [
      "http://1ctx.example.test",
      "http://10.0.0.1",
      "ftp://1ctx.example.test",
      "https://1ctx.example.test/app",
      "https://1ctx.example.test/?a=1",
      "https://1ctx.example.test/#top",
      "https://user:pw@1ctx.example.test",
      "1ctx.example.test",
    ]) {
      expect(publicOrigin(value).ok).toBe(false);
    }
  });

  test("builds a link under the origin from a rooted path only", () => {
    expect(linkOf("https://1ctx.example.test", "/chat/abc")).toBe(
      "https://1ctx.example.test/chat/abc",
    );
    expect(() => linkOf("https://1ctx.example.test", "chat")).toThrow();
    expect(() => linkOf("https://1ctx.example.test", "//evil.test")).toThrow();
  });
});

describe("the rules", () => {
  test("refuse a control character or a line break in a header", () => {
    for (const value of ["a\nb", "a\rb", "a\u0000b", "a\u007fb", "a\u2028b"]) {
      expect(hasControl(value)).toBe(true);
    }
    expect(hasControl("Café, déjà vu ✓")).toBe(false);
  });

  test("try again after 1, 5 and 30 minutes, then give up", () => {
    expect(BACKOFF_MS).toEqual([60_000, 300_000, 1_800_000]);
    expect(retryAt(1, 1000)).toBe(61_000);
    expect(retryAt(2, 1000)).toBe(301_000);
    expect(retryAt(3, 1000)).toBe(1_801_000);
    expect(retryAt(4, 1000)).toBeNull();
  });

  test("name a message by its row and the sender's domain", () => {
    expect(messageIdOf("abc123", "noreply@example.test")).toBe(
      "<abc123@example.test>",
    );
  });
});
