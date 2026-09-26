// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What deleting an agent would do, on the line over its ask, and the
// question a Limits save asks when it lowers the days archived chats
// are kept.

import { describe, expect, test } from "bun:test";
import { impactLine } from "../../../src/client/views/admin/Agents.model.ts";
import {
  deleteAsk,
  keepDays,
} from "../../../src/client/views/admin/Tools.model.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";

describe("the agent delete's line", () => {
  test("each part only when there is any", () => {
    expect(impactLine({ chats: 12, automations: 2, running: 1 })).toBe(
      "12 chats will be archived and 2 automations paused. 1 running now will be stopped.",
    );
    expect(impactLine({ chats: 12, automations: 2, running: 0 })).toBe(
      "12 chats will be archived and 2 automations paused.",
    );
    expect(impactLine({ chats: 3, automations: 0, running: 0 })).toBe(
      "3 chats will be archived.",
    );
    expect(impactLine({ chats: 0, automations: 2, running: 0 })).toBe(
      "2 automations will be paused.",
    );
    expect(impactLine({ chats: 0, automations: 0, running: 2 })).toBe(
      "2 running now will be stopped.",
    );
  });

  test("the singular reads right and nothing says nothing", () => {
    expect(impactLine({ chats: 1, automations: 1, running: 1 })).toBe(
      "1 chat will be archived and 1 automation paused. 1 running now will be stopped.",
    );
    expect(impactLine({ chats: 0, automations: 1, running: 0 })).toBe(
      "1 automation will be paused.",
    );
    expect(impactLine({ chats: 0, automations: 0, running: 0 })).toBe("");
  });

  test("a large count stays exact", () => {
    expect(impactLine({ chats: 1250, automations: 0, running: 0 })).toBe(
      "1,250 chats will be archived.",
    );
  });
});

describe("the Limits save that deletes", () => {
  const row = (name: LimitRow["name"], value: number): LimitRow => ({
    name,
    value,
    default: name === "archivedDeleteDays" ? 365 : 30,
    min: name === "archivedDeleteDays" ? 30 : 1,
    max: name === "archivedDeleteDays" ? 1825 : 180,
    unit: "days",
    scope: "chats",
    changedAt: null,
  });
  const rows = [row("archiveIdleDays", 30), row("archivedDeleteDays", 365)];

  test("lowering the days kept asks, with the new days", () => {
    expect(
      deleteAsk(rows, { archiveIdleDays: "30", archivedDeleteDays: "90" }),
    ).toBe("Delete chats archived over 90 days ago?");
    expect(
      deleteAsk(rows, { archiveIdleDays: "30", archivedDeleteDays: "1825" }),
    ).toBeNull();
    expect(
      deleteAsk([row("archivedDeleteDays", 1825)], {
        archivedDeleteDays: "1200",
      }),
    ).toBe("Delete chats archived over 1,200 days ago?");
  });

  test("raising, keeping, the idle days alone or no number never ask", () => {
    expect(
      deleteAsk(rows, { archiveIdleDays: "10", archivedDeleteDays: "365" }),
    ).toBeNull();
    expect(deleteAsk(rows, { archivedDeleteDays: "" })).toBeNull();
    expect(deleteAsk(rows, { archivedDeleteDays: "abc" })).toBeNull();
    expect(deleteAsk([row("archiveIdleDays", 30)], {})).toBeNull();
  });

  test("days out of range never ask, the save refuses them", () => {
    expect(deleteAsk(rows, { archivedDeleteDays: "10" })).toBeNull();
    expect(deleteAsk(rows, { archivedDeleteDays: "0" })).toBeNull();
    expect(deleteAsk(rows, { archivedDeleteDays: "30" })).toBe(
      "Delete chats archived over 30 days ago?",
    );
  });

  test("Keep takes back the days and nothing else typed", () => {
    expect(
      keepDays(rows, { archiveIdleDays: "12", archivedDeleteDays: "90" }),
    ).toEqual({ archiveIdleDays: "12", archivedDeleteDays: "365" });
    const other = { archiveIdleDays: "12" };
    expect(keepDays([row("archiveIdleDays", 30)], other)).toBe(other);
  });
});
