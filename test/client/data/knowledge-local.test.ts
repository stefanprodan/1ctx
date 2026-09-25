// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the knowledge pages keep in this browser: an unsaved edit per
// user and file, and the tree's open folders per user and project.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DRAFT_PAUSE_MS,
  draftBehind,
  draftOf,
  dropDraft,
  flushDrafts,
  keepDraft,
  knowledgeDraftKey,
  openFolder,
  openFolders,
  openFoldersKey,
  openFoldersOf,
  parseDraft,
  toggleFolder,
} from "../../../src/client/data/knowledge-local.ts";
import { me } from "../../../src/client/data/me.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const reader: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let rows: Map<string, string>;

function storage(value: object): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  rows = new Map();
  storage({
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
  });
  me.value = null;
  me.value = reader;
});

afterEach(() => {
  flushDrafts();
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  }
});

const pause = () =>
  new Promise((resolve) => setTimeout(resolve, DRAFT_PAUSE_MS + 30));

describe("a draft", () => {
  test.serial(
    "is keyed by the user and the file, or the project and folder",
    () => {
      expect(knowledgeDraftKey("u1", { fileId: "f1" })).toBe(
        "knowledge-draft:u1:file:f1",
      );
      expect(
        knowledgeDraftKey("u1", { projectId: "p1", folder: "plans" }),
      ).toBe("knowledge-draft:u1:new:p1:plans");
    },
  );

  test.serial("reads back only its own shape", () => {
    expect(parseDraft('{"text":"a","revision":3,"savedAt":5}')).toEqual({
      text: "a",
      revision: 3,
      savedAt: 5,
    });
    expect(parseDraft('{"text":1}')).toBeNull();
    expect(parseDraft("not json")).toBeNull();
    expect(parseDraft(null)).toBeNull();
  });

  test.serial("made on an older revision is behind, and still a draft", () => {
    const draft = { text: "a", revision: 3, savedAt: 1 };
    expect(draftBehind(draft, 4)).toBe(true);
    expect(draftBehind(draft, 3)).toBe(false);
    expect(draftBehind({ ...draft, revision: null }, 4)).toBe(false);
  });

  test.serial("is kept after a pause and read back at once", async () => {
    keepDraft({ fileId: "f1" }, "edited", 3);
    expect(draftOf({ fileId: "f1" })?.text).toBe("edited");
    expect(rows.size).toBe(0);
    await pause();
    const stored = parseDraft(rows.get("knowledge-draft:u1:file:f1") ?? null);
    expect(stored?.text).toBe("edited");
    expect(stored?.revision).toBe(3);
    // an edit that empties the file is a draft too
    keepDraft({ fileId: "f1" }, "", 3);
    await pause();
    expect(draftOf({ fileId: "f1" })?.text).toBe("");
    dropDraft({ fileId: "f1" });
    expect(draftOf({ fileId: "f1" })).toBeNull();
    expect(rows.size).toBe(0);
  });

  test.serial("of a new file with nothing typed is none", async () => {
    const scope = { projectId: "p1", folder: "plans" };
    keepDraft(scope, "", null);
    await pause();
    expect(rows.size).toBe(0);
    keepDraft(scope, "", null, "plans/x.md");
    await pause();
    expect(draftOf(scope)?.name).toBe("plans/x.md");
  });

  test.serial("is another user's no longer", async () => {
    keepDraft({ fileId: "f1" }, "mine", 3);
    await pause();
    me.value = { ...reader, id: "u2" };
    expect(draftOf({ fileId: "f1" })).toBeNull();
  });

  test.serial(
    "waiting out its pause at a user change is the old user's",
    () => {
      keepDraft({ fileId: "f1" }, "mine", 3);
      me.value = { ...reader, id: "u2" };
      expect([...rows.keys()]).toEqual(["knowledge-draft:u1:file:f1"]);
      expect(draftOf({ fileId: "f1" })).toBeNull();
    },
  );

  test.serial("survives a storage that throws", () => {
    storage({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(draftOf({ fileId: "f1" })).toBeNull();
    keepDraft({ fileId: "f1" }, "a", 1);
    expect(() => flushDrafts()).not.toThrow();
    expect(() => dropDraft({ fileId: "f1" })).not.toThrow();
  });
});

describe("the open folders", () => {
  test.serial("a fresh browser opens none", () => {
    expect(openFoldersOf("p1").size).toBe(0);
  });

  test.serial("a toggle opens and closes, kept per user and project", () => {
    toggleFolder("p1", "plans");
    expect([...openFoldersOf("p1")]).toEqual(["plans"]);
    expect(rows.get(openFoldersKey("u1", "p1"))).toBe('["plans"]');
    expect(openFoldersOf("p2").size).toBe(0);
    // a reload reads them back
    openFolders.value = new Map();
    expect([...openFoldersOf("p1")]).toEqual(["plans"]);
    toggleFolder("p1", "plans");
    expect(openFoldersOf("p1").size).toBe(0);
    expect(rows.has(openFoldersKey("u1", "p1"))).toBe(false);
  });

  test.serial("a folder link opens it and its parents", () => {
    toggleFolder("p1", "notes");
    openFolder("p1", "plans/x");
    expect([...openFoldersOf("p1")].sort()).toEqual([
      "notes",
      "plans",
      "plans/x",
    ]);
  });

  test.serial("a folder link opens a lone folder closed by hand", () => {
    toggleFolder("p1", "!docs");
    openFolder("p1", "docs/v1");
    expect([...openFoldersOf("p1")].sort()).toContain("docs/v1");
    expect(openFoldersOf("p1").has("!docs")).toBe(false);
  });

  test.serial("another user's are not read", () => {
    toggleFolder("p1", "plans");
    me.value = { ...reader, id: "u2" };
    expect(openFoldersOf("p1").size).toBe(0);
  });
});
