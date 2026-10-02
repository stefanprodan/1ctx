// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type RepoFields,
  ReposStore,
  view,
} from "../../../src/server/repos/index.ts";
import { memoryDb } from "../../helpers/db.ts";

function seeded() {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash,
        created_at)
      values ('u', 'casey', 'Casey Doe', 'casey@example.test', 'admin', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('p1', 'team', 'platform', 'u', 0), ('p2', 'team', 'finops', 'u', 0);
  `);
  return { db, store: new ReposStore(db) };
}

const fields = (over: Partial<RepoFields> = {}): RepoFields => ({
  name: "widgets",
  url: "https://github.com/acme/widgets",
  kind: "github",
  ref: "",
  keyName: null,
  ignore: "",
  ...over,
});

test("a row is made pending, listed by name and found in its project only", () => {
  const { db, store } = seeded();
  try {
    const made = store.create("p1", fields(), 10);
    store.create("p1", fields({ name: "charts" }), 11);
    store.create("p2", fields(), 12);
    expect(made).toMatchObject({
      projectId: "p1",
      name: "widgets",
      state: "pending",
      error: null,
      commit: null,
      etag: null,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(store.forProject("p1").map((row) => row.name)).toEqual([
      "charts",
      "widgets",
    ]);
    expect(store.count("p1")).toBe(2);
    expect(store.inProject("p2", made.id)).toBeNull();
    expect(store.inProject("p1", made.id)?.id).toBe(made.id);
    expect(store.nameTaken("p1", "widgets")).toBe(true);
    expect(store.nameTaken("p1", "widgets", made.id)).toBe(false);
    expect(() => store.create("p1", fields(), 13)).toThrow(/UNIQUE/);
    const shown = view(made, false);
    expect(shown).not.toHaveProperty("etag");
    expect(shown).not.toHaveProperty("projectId");
    // a key's name is an admin's to see
    expect(shown).not.toHaveProperty("keyName");
    expect(view(made, true)).toHaveProperty("keyName", null);
  } finally {
    db.close();
  }
});

test("a fetched row keeps what a change leaves out, and a refetch clears what the fetch found", () => {
  const { db, store } = seeded();
  try {
    const { id } = store.create("p1", fields({ keyName: "http-github" }), 10);
    store.setFetched(id, {
      state: "ready",
      error: null,
      etag: '"abc"',
      commit: "a".repeat(40),
      fetchedAt: 20,
      files: 364,
      bytes: 1024,
      ignored: 3,
    });
    store.setFetched(id, { state: "failed", error: "host unreachable" });
    expect(store.byId(id)).toMatchObject({
      state: "failed",
      error: "host unreachable",
      etag: '"abc"',
      commit: "a".repeat(40),
      fetchedAt: 20,
      files: 364,
      bytes: 1024,
      ignored: 3,
    });
    store.create("p2", fields({ name: "charts" }), 11);
    expect(store.usingKeys()).toEqual([
      { keyName: "http-github", projectId: "p1", name: "widgets" },
    ]);
    store.update(
      id,
      fields({ name: "renamed", keyName: "http-github" }),
      false,
      30,
    );
    expect(store.byId(id)).toMatchObject({
      name: "renamed",
      state: "failed",
      error: "host unreachable",
      updatedAt: 30,
    });
    store.update(id, fields({ name: "renamed", ref: "main" }), true, 40);
    expect(store.byId(id)).toMatchObject({
      ref: "main",
      keyName: null,
      state: "pending",
      error: null,
      etag: null,
      commit: null,
      fetchedAt: null,
      files: null,
      bytes: null,
      ignored: null,
    });
    store.setFetched(id, { state: "fetching", error: null });
    expect(store.resetFetching()).toBe(1);
    expect(store.byId(id)?.state).toBe("pending");
    store.setFetched(id, { state: "failed", error: "not found" });
    expect(store.markPending(id, 50)).toMatchObject({
      state: "pending",
      error: null,
      updatedAt: 50,
    });
    expect(store.delete(id)).toBe(true);
    expect(store.delete(id)).toBe(false);
  } finally {
    db.close();
  }
});
