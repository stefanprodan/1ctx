// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat menu's states: opened and closed by the title, the delete
// question asked and kept, a delete on its way that nothing closes,
// and a failure shown in the question's place.

import { describe, expect, test } from "bun:test";
import {
  CLOSED,
  type MenuAction,
  menuItems,
  menuStep,
} from "../../../src/client/views/sessions/Menu.model.ts";

const after = (...actions: MenuAction[]) => actions.reduce(menuStep, CLOSED);

describe("the chat menu", () => {
  test("the title toggles it and a press outside or Escape closes it", () => {
    expect(after("toggle")).toEqual({ ...CLOSED, open: true });
    expect(after("toggle", "toggle")).toEqual(CLOSED);
    expect(after("toggle", "dismiss")).toEqual(CLOSED);
  });

  test("Delete asks, Keep withdraws, closing forgets the question", () => {
    expect(after("toggle", { ask: "delete" })).toEqual({
      ...CLOSED,
      open: true,
      asking: "delete",
    });
    expect(after("toggle", { ask: "delete" }, "keep")).toEqual({
      ...CLOSED,
      open: true,
    });
    expect(after("toggle", { ask: "delete" }, "dismiss")).toEqual(CLOSED);
    expect(after("toggle", { ask: "delete" }, "toggle", "toggle")).toEqual({
      ...CLOSED,
      open: true,
    });
  });

  test("a delete on its way is not closed, kept or toggled away", () => {
    const busy = after("toggle", { ask: "delete" }, "start");
    expect(busy).toEqual({
      open: true,
      asking: "delete",
      editing: false,
      busy: true,
      failure: null,
    });
    expect(menuStep(busy, "dismiss")).toBe(busy);
    expect(menuStep(busy, "keep")).toBe(busy);
    expect(menuStep(busy, "toggle")).toBe(busy);
  });

  test("a failure takes the question's place until Keep or a retry", () => {
    const failed = after("toggle", { ask: "delete" }, "start", {
      failed: "409",
    });
    expect(failed).toEqual({
      open: true,
      asking: "delete",
      editing: false,
      busy: false,
      failure: "409",
    });
    expect(menuStep(failed, "start").failure).toBeNull();
    expect(menuStep(failed, "keep")).toEqual({ ...CLOSED, open: true });
  });

  test("Rename shuts the menu and opens the box; a save or Escape shuts it", () => {
    expect(after("toggle", "edit")).toEqual({ ...CLOSED, editing: true });
    expect(after("toggle", "edit", "dismiss")).toEqual(CLOSED);
    const saving = after("toggle", "edit", "start");
    expect(saving).toEqual({ ...CLOSED, editing: true, busy: true });
    expect(menuStep(saving, "dismiss")).toBe(saving);
    expect(menuStep(saving, "saved")).toEqual(CLOSED);
    expect(menuStep(saving, { failed: "409" })).toEqual({
      ...CLOSED,
      editing: true,
      failure: "409",
    });
    expect(menuStep(saving, "edit")).toBe(saving);
  });

  test("Archive asks its own question and a done archive shuts the menu", () => {
    expect(after("toggle", { ask: "archive" }).asking).toBe("archive");
    expect(after("toggle", { ask: "archive" }, "keep").asking).toBeNull();
    expect(after("toggle", { ask: "archive" }, "start", "saved")).toEqual(
      CLOSED,
    );
  });
});

describe("the chat menu's items", () => {
  test("a member archives, the owner also renames and deletes", () => {
    expect(menuItems({ run: false, archived: false, manage: false })).toEqual({
      rename: false,
      archive: true,
      delete: false,
    });
    expect(menuItems({ run: false, archived: false, manage: true })).toEqual({
      rename: true,
      archive: true,
      delete: true,
    });
  });

  test("an archived chat keeps Delete alone, for whoever may delete", () => {
    expect(menuItems({ run: false, archived: true, manage: true })).toEqual({
      rename: false,
      archive: false,
      delete: true,
    });
    expect(menuItems({ run: false, archived: true, manage: false })).toEqual({
      rename: false,
      archive: false,
      delete: false,
    });
  });

  test("a run is never archived or renamed", () => {
    expect(menuItems({ run: true, archived: false, manage: true })).toEqual({
      rename: false,
      archive: false,
      delete: true,
    });
  });
});
