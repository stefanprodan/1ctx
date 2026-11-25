// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { EXTERNAL_TASKS_SKILL_PATH as SKILL_PATH } from "../../../src/shared/skills.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import { fixture } from "./helper.ts";

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

for (const scope of ["read", "write"] as const) {
  for (const era of ["legacy", "modern"] as const) {
    test(`a ${scope} key's ${era} client lists and reads the skill, verified`, async () => {
      const { area, send } = fixture(scope);
      const client = new Client(
        { name: "test", version: "1" },
        era === "modern"
          ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
          : undefined,
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://1ctx.test/mcp"), {
          fetch: (url, init) => send(new Request(url, init)),
        }),
      );
      const skills = new SkillsClient(client);
      expect(skills.supported).toBe(true);
      const listing = await skills.list();
      expect(listing.skills.map((entry) => entry.uri)).toEqual([
        "skill://external-tasks/SKILL.md",
      ]);
      const file = await skills.read(listing.skills[0]!);
      expect(file.verified).toBe(true);
      expect(file.text).toBe(repo);
      const resources = await client.listResources();
      expect(resources.resources.map((entry) => entry.uri)).toEqual([
        "skill://external-tasks/SKILL.md",
      ]);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "projects",
        "knowledge",
        "sessions",
        "tasks",
      ]);
      await client.close();
      await area.close();
    });
  }
}
