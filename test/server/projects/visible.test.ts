// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who may see a project: a personal project is its owner's alone, an
// admin included; a team project is open to its members and to admins.

import { describe, expect, test } from "bun:test";
import type { ProjectRow } from "../../../src/server/projects/index.ts";
import { visible } from "../../../src/server/projects/index.ts";

const personal: ProjectRow = {
  id: "p1",
  kind: "personal",
  name: "caelea",
  ownerId: "u1",
  createdAt: 0,
  description: "",
};
const team: ProjectRow = { ...personal, id: "p2", kind: "team", name: "ops" };
const owner = { userId: "u1", role: "member" as const };
const other = { userId: "u2", role: "member" as const };
const admin = { userId: "u3", role: "admin" as const };

describe("visible", () => {
  test("a personal project is its owner's alone", () => {
    expect(visible(personal, owner, true)).toBe(true);
    expect(visible(personal, other, false)).toBe(false);
    expect(visible(personal, admin, false)).toBe(false);
    // membership is not enough: the row says whose it is
    expect(visible(personal, admin, true)).toBe(false);
  });

  test("a team project is open to its members and to admins", () => {
    expect(visible(team, other, true)).toBe(true);
    expect(visible(team, other, false)).toBe(false);
    expect(visible(team, admin, false)).toBe(true);
  });
});
