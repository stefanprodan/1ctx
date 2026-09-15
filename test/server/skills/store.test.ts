// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { LoadedSkill } from "../../../src/server/skills/load.ts";
import { SkillStore } from "../../../src/server/skills/store.ts";
import { memoryDb } from "../../helpers/db.ts";

const loaded = (name: string): LoadedSkill => ({
  name,
  description: `${name} description`,
  body: `${name} body`,
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  sourceKind: "file",
  sourceUrl: `https://skills.test/${name}.md`,
  sourceSelect: "",
  sourceDigest: "",
  digest: `${name}-digest`,
  dropped: [],
  droppedMore: 0,
  files: [{ path: "references/a.md", content: "a", bytes: 1 }],
});

function seeded() {
  const db = memoryDb();
  db.exec(`
    insert into providers (id, name, wire, base_url, created_at)
      values ('p', 'provider', 'openai-compatible', 'http://models.test', 0);
    insert into agents (id, name, provider_id, model, model_name, created_at)
      values ('a', 'agent-one', 'p', 'm', 'Model', 0);
  `);
  return { db, store: new SkillStore(db, () => ["agent-one"]) };
}

describe("SkillStore", () => {
  test("creates, lists and replaces while keeping assignments", () => {
    const { db, store } = seeded();
    const z = store.create(loaded("z-skill"), 1);
    const a = store.create(loaded("a-skill"), 2);
    store.assign("a", [z.id, a.id]);
    expect(store.assigned("a")).toEqual([a.id, z.id]);
    expect(store.forAgent("a").map((skill) => skill.name)).toEqual([
      "a-skill",
      "z-skill",
    ]);
    const replaced = store.replace(
      z.id,
      { ...loaded("z-skill"), body: "new body" },
      {
        at: 3,
        body: true,
        description: false,
        fields: [],
        files: { added: [], removed: [], changed: [] },
      },
      3,
    );
    expect(replaced?.id).toBe(z.id);
    expect(replaced?.body).toBe("new body");
    expect(store.assigned("a")).toContain(z.id);
    db.close();
  });

  test("refuses duplicate names and deletion while assigned", () => {
    const { db, store } = seeded();
    const row = store.create(loaded("ops"), 1);
    expect(() => store.create(loaded("ops"), 2)).toThrow("exists");
    store.assign("a", [row.id]);
    expect(() => store.delete(row.id)).toThrow("agent-one");
    store.assign("a", []);
    expect(store.delete(row.id)).toBeTrue();
    db.close();
  });
});
