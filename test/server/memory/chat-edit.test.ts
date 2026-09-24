// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  chatEdit,
  noteWords,
  savedWords,
} from "../../../src/server/memory/index.ts";
import type { MemoryEntry } from "../../../src/shared/contracts/memory.ts";
import {
  MEMORY_CHARS,
  MEMORY_ENTRY_CHARS,
} from "../../../src/shared/memory.ts";

const entry = (topic: string, text: string): MemoryEntry => ({ topic, text });

describe("a chat's edit of the project's note", () => {
  test("applies over what the chat saw and records the result as seen", () => {
    const note = [entry("Units", "metric")];
    const outcome = chatEdit(note, note, {
      action: "set",
      topic: "units",
      text: "metric, SI",
    });
    expect(outcome).toEqual({
      ok: true,
      entries: [entry("units", "metric, SI")],
      seen: [entry("units", "metric, SI")],
      changed: true,
    });
  });

  test("creates a topic nobody wrote, beside one another chat wrote", () => {
    const outcome = chatEdit([entry("Time", "UTC")], [], {
      action: "set",
      topic: "Units",
      text: "metric",
    });
    expect(outcome).toEqual({
      ok: true,
      entries: [entry("Time", "UTC"), entry("Units", "metric")],
      seen: [entry("Units", "metric")],
      changed: true,
    });
  });

  test("refuses a topic another chat wrote since and marks the note seen", () => {
    const note = [entry("Units", "metric only"), entry("Time", "UTC")];
    const outcome = chatEdit(note, [entry("Units", "metric")], {
      action: "set",
      topic: "Units",
      text: "metric and imperial",
    });
    expect(outcome).toEqual({
      ok: false,
      reason:
        "Another chat wrote the topic Units since this chat last saw it. Its text is in the note below. Merge your text into it and set it again.",
      seen: note,
    });
    // the retry, over what the refusal showed, applies
    const retry = chatEdit(note, note, {
      action: "set",
      topic: "Units",
      text: "metric only, never imperial",
    });
    expect(retry.ok).toBe(true);
  });

  test("refuses a topic the chat never saw that another chat added", () => {
    const outcome = chatEdit([entry("Units", "metric")], [], {
      action: "remove",
      topic: "Units",
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe(
      "Another chat wrote the topic Units since this chat last saw it. Its text is in the note below. Remove it again only if it is still stale.",
    );
  });

  test("refuses a set of a topic removed elsewhere, then lets it be made", () => {
    const outcome = chatEdit([], [entry("Units", "metric")], {
      action: "set",
      topic: "Units",
      text: "SI",
    });
    expect(outcome).toEqual({
      ok: false,
      reason:
        "Another chat removed the topic Units since this chat last saw it. Set it again only if it is still needed.",
      seen: [],
    });
    expect(
      chatEdit([], [], { action: "set", topic: "Units", text: "SI" }).ok,
    ).toBe(true);
  });

  test("a remove of a topic removed elsewhere is a success that changes nothing", () => {
    const note = [entry("Time", "UTC")];
    expect(
      chatEdit(note, [entry("Units", "metric"), entry("Time", "UTC")], {
        action: "remove",
        topic: "Units",
      }),
    ).toEqual({
      ok: true,
      entries: note,
      seen: [entry("Time", "UTC")],
      changed: false,
    });
  });

  test("a set the note already holds is a success that changes nothing", () => {
    const note = [entry("Units", "metric")];
    expect(
      chatEdit(note, [], { action: "set", topic: "Units", text: "metric" }),
    ).toEqual({
      ok: true,
      entries: note,
      seen: note,
      changed: false,
    });
  });

  test("a remove of a topic nobody wrote lists the topics", () => {
    const note = [entry("Time", "UTC")];
    expect(chatEdit(note, note, { action: "remove", topic: "Units" })).toEqual({
      ok: false,
      reason:
        "No entry has topic Units. Topics: Time. Use one of the topics in the note.",
      seen: note,
    });
  });

  test("the budget refusal asks to make room and marks the note seen", () => {
    const big = "x".repeat(MEMORY_ENTRY_CHARS);
    const note = [1, 2, 3, 4].map((n) => entry(`Topic ${n}`, big));
    const outcome = chatEdit(note, [], {
      action: "set",
      topic: "Topic 5",
      text: big,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toStartWith("The note would be");
    expect(outcome.reason).toEndWith(
      "Shorten, merge or remove entries, or leave out what later chats do not need.",
    );
    expect(outcome.reason).not.toContain("Cut or remove");
    expect(outcome.seen).toEqual(note);
  });

  test("the words: saved with the size, a refusal with each entry's", () => {
    const note = [entry("Units", "metric")];
    expect(savedWords(note)).toBe(
      `Saved to the project's memory. 15 of ${MEMORY_CHARS.toLocaleString("en-US")} characters.`,
    );
    expect(noteWords("Refused.", note)).toBe(
      `Refused.\n1. Units [6/${MEMORY_ENTRY_CHARS}]\nmetric\n15 of 2,200 characters.`,
    );
    expect(noteWords("Refused.", [])).toBe("Refused.\n0 of 2,200 characters.");
  });
});
