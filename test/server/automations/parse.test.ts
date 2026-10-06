// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  parsePatchAutomation,
  parseRunsQuery,
} from "../../../src/server/automations/parse.ts";
import { MAX_NAME, MIN_NAME } from "../../../src/shared/words.ts";

test("an automation's name follows the shared name rule", () => {
  expect(parsePatchAutomation({ name: "nightly-report" }).name).toBe(
    "nightly-report",
  );
  expect(() => parsePatchAutomation({ name: "Nightly Report" })).toThrow(
    `name must be ${MIN_NAME} to ${MAX_NAME} `,
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
