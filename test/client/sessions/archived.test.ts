// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An archived chat's foot line: why, per reason, then until when, the
// date on one line; and the foot's Fork list, which a deleted agent is
// not on.

import { describe, expect, test } from "bun:test";
import { forkChoices } from "../../../src/client/transcript/Fork.model.ts";
import {
  archivedLine,
  forkAgents,
} from "../../../src/client/views/sessions/Chat.model.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";

const DAY = 86_400_000;
const at = new Date(2026, 8, 26, 14).getTime();
const keptUntil = new Date(2027, 8, 26, 14).getTime();
const kept = " · kept until 26\u00a0Sep\u00a02027";

describe("the archived line", () => {
  test("a chat archived by hand names who and the day", () => {
    expect(
      archivedLine(
        { archived: { at, reason: "manual" }, lastActivityAt: at - DAY },
        { by: { id: "u1", username: "ana" }, keptUntil },
      ),
    ).toBe(`Archived by @ana on 26 Sep${kept}`);
  });

  test("a deleted user leaves the day alone", () => {
    expect(
      archivedLine(
        { archived: { at, reason: "manual" }, lastActivityAt: at },
        { by: null, keptUntil },
      ),
    ).toBe(`Archived on 26 Sep${kept}`);
  });

  test("an agent's delete and an idle chat say so", () => {
    expect(
      archivedLine(
        { archived: { at, reason: "agent" }, lastActivityAt: at },
        { by: null, keptUntil },
      ),
    ).toBe(`Archived when its agent was deleted${kept}`);
    // the sweep runs hourly, so the archive lands within the hour
    expect(
      archivedLine(
        {
          archived: { at, reason: "idle" },
          lastActivityAt: at - 30 * DAY - 40 * 60_000,
        },
        { by: null, keptUntil },
      ),
    ).toBe(`Archived after 30 days without activity${kept}`);
  });

  test("before the detail answers, the line says only why", () => {
    expect(
      archivedLine(
        { archived: { at, reason: "agent" }, lastActivityAt: at },
        null,
      ),
    ).toBe("Archived when its agent was deleted");
  });

  test("a live chat has no line", () => {
    expect(archivedLine({ archived: null, lastActivityAt: at }, null)).toBe("");
  });
});

describe("the fork list", () => {
  const agent = (id: string) => ({ id, name: id }) as AgentSummary;
  test("the chat's own agent leads while it is live", () => {
    const list = [agent("a"), agent("b"), agent("c")];
    expect(forkChoices(list, "b").map((a) => a.id)).toEqual(["b", "a", "c"]);
  });

  test("a deleted agent the project list still holds is left out", () => {
    const list = [agent("gone"), agent("a"), agent("c")];
    const named = [
      { id: "gone", name: "gone", avatar: "bot" as const, retired: true },
      { id: "a", name: "a", avatar: "bot" as const, retired: false },
    ];
    expect(forkAgents(list, named).map((a) => a.id)).toEqual(["a", "c"]);
  });

  test("a deleted agent is left out, no row marked as the chat's", () => {
    // the project's agents are the live ones: a retired id is not there
    const list = [agent("a"), agent("c")];
    expect(forkChoices(list, "gone").map((a) => a.id)).toEqual(["a", "c"]);
  });
});
