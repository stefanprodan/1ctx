// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  parsePatchAutomation,
  parseRunsQuery,
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
