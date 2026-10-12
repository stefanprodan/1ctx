// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_TASKS_SKILL_PATH as SKILL_PATH } from "../../../src/shared/skills.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";

const repo = readFileSync(
  join(import.meta.dir, "../../../skills/external-tasks/SKILL.md"),
  "utf8",
);

test("anyone fetches the skill as markdown, and nothing is logged", async () => {
  const logs = collectLogs();
  const app = await testApp({ logFactory: logs.logFactory });
  const res = await app.client().call("GET", SKILL_PATH, { origin: null });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(await res.text()).toBe(repo);
  expect(logs.events.filter((e) => e.msg === "request")).toEqual([]);
});
