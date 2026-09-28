// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The question a Limits save asks when it lowers the days archived chats
// are kept.

import { describe, expect, test } from "bun:test";
import {
  deleteAsk,
  keepDays,
} from "../../../src/client/views/admin/Limits.model.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";

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
