// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  draftKey,
  dropDraftUploads,
  EMPTY_DRAFT,
  readDraft,
  writeDraft,
  writeDraftText,
  writeDraftUploads,
} from "../../../src/client/composer/draft.ts";

const KEY = "draft:u1:chat:s1";
const FILE = { projectId: "p1", id: "up1", name: "notes.md" };

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
});

afterEach(() => {
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  }
});

describe("composer drafts", () => {
  test("keys drafts by user, then by chat or project", () => {
    expect(draftKey("u1", { sessionId: "s1" })).toBe("draft:u1:chat:s1");
    expect(draftKey("u1", { projectId: "p1" })).toBe("draft:u1:project:p1");
    expect(draftKey("u2", { projectId: "home" })).toBe("draft:u2:project:home");
  });

  test("writes and reads the text and the staged files", () => {
    writeDraft(KEY, { text: "hello", uploads: [FILE] });

    expect(readDraft(KEY)).toEqual({ text: "hello", uploads: [FILE] });
  });

  test("each half is written without the other", () => {
    writeDraftText(KEY, "hello");
    writeDraftUploads(KEY, [FILE]);
    writeDraftText(KEY, "hello again");

    expect(readDraft(KEY)).toEqual({ text: "hello again", uploads: [FILE] });
  });

  test("an empty draft removes its key, files alone keep it", () => {
    writeDraft(KEY, { text: "hello", uploads: [FILE] });

    writeDraftText(KEY, "");
    expect(rows.has(KEY)).toBe(true);

    writeDraftUploads(KEY, []);
    expect(rows.has(KEY)).toBe(false);
    expect(readDraft(KEY)).toEqual(EMPTY_DRAFT);
  });

  test("a send drops only its ids from the draft as stored now", () => {
    const later = { projectId: "p2", id: "up2", name: "later.md" };
    writeDraft(KEY, { text: "typed since", uploads: [FILE, later] });

    dropDraftUploads(KEY, ["up1"]);

    expect(readDraft(KEY)).toEqual({ text: "typed since", uploads: [later] });
  });

  test("what is not a draft reads as empty, a bad file row is dropped", () => {
    rows.set(KEY, "hello");
    expect(readDraft(KEY)).toEqual(EMPTY_DRAFT);

    rows.set(KEY, JSON.stringify({ text: 7, uploads: [FILE, { id: "x" }] }));
    expect(readDraft(KEY)).toEqual({ text: "", uploads: [FILE] });
  });

  test("storage failures are swallowed", () => {
    storage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });

    expect(readDraft(KEY)).toEqual(EMPTY_DRAFT);
    expect(() => writeDraft(KEY, { text: "hello", uploads: [] })).not.toThrow();
    expect(() => writeDraft(KEY, EMPTY_DRAFT)).not.toThrow();
  });
});
