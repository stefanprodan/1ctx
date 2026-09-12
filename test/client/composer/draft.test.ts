// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  draftKey,
  readDraft,
  writeDraft,
} from "../../../src/client/composer/draft.ts";

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
  test("keys drafts by chat or project", () => {
    expect(draftKey({ sessionId: "s1" })).toBe("draft:chat:s1");
    expect(draftKey({ projectId: "p1" })).toBe("draft:project:p1");
  });

  test("writes and reads a draft", () => {
    writeDraft("draft:chat:s1", "hello");

    expect(readDraft("draft:chat:s1")).toBe("hello");
  });

  test("an empty draft removes its key", () => {
    writeDraft("draft:chat:s1", "hello");

    writeDraft("draft:chat:s1", "");

    expect(rows.has("draft:chat:s1")).toBe(false);
    expect(readDraft("draft:chat:s1")).toBe("");
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

    expect(readDraft("draft:chat:s1")).toBe("");
    expect(() => writeDraft("draft:chat:s1", "hello")).not.toThrow();
    expect(() => writeDraft("draft:chat:s1", "")).not.toThrow();
  });
});
