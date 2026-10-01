// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../../src/server/db/index.ts";
import { provisionPaths } from "../../../src/server/provision/index.ts";
import { network, object, recompose } from "./helpers.ts";

const project = (description: string) =>
  JSON.stringify(object("Project", "nebula", { description }));

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-provision-run-"));
  const fake = network();
  const now = { value: 1_000_000 };
  const run = (paths: string[], optional = true) =>
    provisionPaths({
      paths,
      dbPath: join(dir, "data", "1ctx.sqlite"),
      compose: (db: Db) => recompose({ db, now }, fake.fetcher),
      optional,
    });
  const descriptions = () => {
    const db = new Database(join(dir, "data", "1ctx.sqlite"), {
      readonly: true,
    });
    try {
      return db
        .query<{ description: string }, []>(
          "select description from projects where kind = 'team'",
        )
        .all()
        .map((row) => row.description);
    } finally {
      db.close();
    }
  };
  return {
    dir,
    run,
    descriptions,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a folder applies at start and applies again as unchanged", async () => {
  const w = workspace();
  try {
    const folder = join(w.dir, "provision");
    mkdirSync(folder);
    writeFileSync(join(folder, "team.yaml"), project("A team project."));
    writeFileSync(join(folder, "notes.txt"), "not an object");

    const first = await w.run([folder]);
    expect(first?.counts).toEqual({ created: 1, updated: 0, unchanged: 0 });
    expect(first?.migrations.length).toBeGreaterThan(0);
    expect(w.descriptions()).toEqual(["A team project."]);

    const second = await w.run([folder]);
    expect(second).toEqual({
      counts: { created: 0, updated: 0, unchanged: 1 },
      migrations: [],
    });
  } finally {
    w.cleanup();
  }
});

test("a missing path or a folder with no YAML applies nothing", async () => {
  const w = workspace();
  try {
    const empty = join(w.dir, "empty");
    mkdirSync(join(empty, "nested"), { recursive: true });
    writeFileSync(join(empty, "nested", "team.yaml"), project("Deeper."));
    expect(await w.run([join(w.dir, "absent")])).toBeNull();
    expect(await w.run([empty])).toBeNull();
    expect(existsSync(join(w.dir, "data"))).toBe(false);
    // the provision command still names a path it cannot read
    await expect(w.run([join(w.dir, "absent")], false)).rejects.toThrow(
      "could not read input",
    );
  } finally {
    w.cleanup();
  }
});

test("a broken file fails before anything is written", async () => {
  const w = workspace();
  try {
    const folder = join(w.dir, "provision");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.yaml"), project("A team project."));
    writeFileSync(join(folder, "b.yaml"), "kind: [unclosed");
    await expect(w.run([folder])).rejects.toThrow("invalid YAML");
    expect(existsSync(join(w.dir, "data"))).toBe(false);

    rmSync(join(folder, "b.yaml"));
    await w.run([folder]);
    writeFileSync(join(folder, "a.yaml"), project("Changed."));
    writeFileSync(
      join(folder, "b.yaml"),
      JSON.stringify(object("Project", "orbit", { owner: "nobody" })),
    );
    await expect(w.run([folder])).rejects.toThrow(
      "spec.owner is an unknown field",
    );
    expect(w.descriptions()).toEqual(["A team project."]);
  } finally {
    w.cleanup();
  }
});
