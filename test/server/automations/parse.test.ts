// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  compareAfter,
  parsePatchAutomation,
  parseRunsQuery,
  parseSaveAutomation,
} from "../../../src/server/automations/parse.ts";
import { MAX_NAME, MIN_NAME } from "../../../src/shared/words.ts";

test("an automation's name follows the shared name rule", () => {
  expect(
    parsePatchAutomation({ name: "nightly-report", editRevision: 0 }).patch
      .name,
  ).toBe("nightly-report");
  expect(() =>
    parsePatchAutomation({ name: "Nightly Report", editRevision: 0 }),
  ).toThrow(`name must be ${MIN_NAME} to ${MAX_NAME} `);
});

test("a patch names the edit revision it started from", () => {
  expect(parsePatchAutomation({ tz: "UTC", editRevision: 3 })).toEqual({
    patch: { tz: "UTC" },
    editRevision: 3,
  });
  for (const editRevision of [undefined, -1, 1.5, "2"]) {
    expect(() => parsePatchAutomation({ tz: "UTC", editRevision })).toThrow(
      "editRevision must be a non-negative integer",
    );
  }
  expect(() => parsePatchAutomation({ editRevision: 0 })).toThrow(
    "empty patch",
  );
});

test("the runs query refuses unknown and repeated names", () => {
  const runs = (query: string) =>
    parseRunsQuery(new URL(`http://x/api/automations/a/runs${query}`));
  expect(runs("?filter=manual")).toEqual({ filter: "manual", before: null });
  expect(() => runs("?page=2")).toThrow("unknown parameter page");
  expect(() => runs("?filter=manual&filter=attention")).toThrow(
    "filter must appear once",
  );
});

test("a check URL is an MCP server's URL, null or empty for none", () => {
  const patch = (checkUrl: unknown) =>
    parsePatchAutomation({ checkUrl, editRevision: 0 }).patch.checkUrl;
  expect(patch("https://api.test/search?q=open")).toBe(
    "https://api.test/search?q=open",
  );
  expect(patch(null)).toBeNull();
  expect(patch("")).toBeNull();
  expect(() => patch("ftp://api.test/")).toThrow(
    "Check URL must be an http or https URL",
  );
  expect(() => patch("https://user:pw@api.test/")).toThrow(
    "Check URL must not hold a user or a fragment",
  );
  expect(() => patch(`https://api.test/${"x".repeat(2048)}`)).toThrow(
    "Check URL is too long",
  );
  expect(() => patch(7)).toThrow("Check URL must be a URL");
  // a patch without it keeps it
  expect(
    Object.hasOwn(
      parsePatchAutomation({ tz: "UTC", editRevision: 0 }).patch,
      "checkUrl",
    ),
  ).toBe(false);
});

test("a compare is a dotted path, null or empty for none", () => {
  const patch = (checkCompare: unknown) =>
    parsePatchAutomation({ checkCompare, editRevision: 0 }).patch.checkCompare;
  expect(patch(" .tag_name ")).toBe("tag_name");
  expect(patch("data.items[0].id")).toBe("data.items[0].id");
  expect(patch(null)).toBeNull();
  expect(patch(" ")).toBeNull();
  for (const bad of ["a..b", "$.a", 7, `a${".b".repeat(100)}`]) {
    expect(() => patch(bad)).toThrow(
      "Compare must be a dotted path like tag_name or items[0].id",
    );
  }
});

test("a compare needs a check URL, and a cleared URL takes it along", () => {
  const body = {
    name: "nightly",
    agentId: "a1",
    instructions: "check",
    schedule: "0 9 * * *",
    tz: "UTC",
    deadlineMs: null,
    retentionDays: 30,
    ownMemory: false,
  };
  expect(() => parseSaveAutomation({ ...body, checkCompare: "a" })).toThrow(
    "Compare needs a Check URL",
  );
  expect(
    parseSaveAutomation({
      ...body,
      checkUrl: "https://api.test/x",
      checkCompare: "a",
    }).checkCompare,
  ).toBe("a");
  expect(parseSaveAutomation(body).checkCompare).toBeNull();
  const row = { checkUrl: "https://api.test/x", checkCompare: "a" };
  expect(compareAfter(row, { name: "x" })).toBe("a");
  expect(compareAfter(row, { checkCompare: "b" })).toBe("b");
  expect(compareAfter(row, { checkUrl: null })).toBeNull();
  expect(() =>
    compareAfter(row, { checkUrl: null, checkCompare: "a" }),
  ).toThrow("Compare needs a Check URL");
  expect(() =>
    compareAfter({ checkUrl: null, checkCompare: null }, { checkCompare: "a" }),
  ).toThrow("Compare needs a Check URL");
});
