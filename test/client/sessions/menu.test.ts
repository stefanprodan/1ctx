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
    expect(after("toggle", "ask")).toEqual({
      ...CLOSED,
      open: true,
      asking: true,
    });
    expect(after("toggle", "ask", "keep")).toEqual({ ...CLOSED, open: true });
    expect(after("toggle", "ask", "dismiss")).toEqual(CLOSED);
    expect(after("toggle", "ask", "toggle", "toggle")).toEqual({
      ...CLOSED,
      open: true,
    });
  });

  test("a delete on its way is not closed, kept or toggled away", () => {
    const busy = after("toggle", "ask", "start");
    expect(busy).toEqual({
      open: true,
      asking: true,
      busy: true,
      failure: null,
    });
    expect(menuStep(busy, "dismiss")).toBe(busy);
    expect(menuStep(busy, "keep")).toBe(busy);
    expect(menuStep(busy, "toggle")).toBe(busy);
  });

  test("a failure takes the question's place until Keep or a retry", () => {
    const failed = after("toggle", "ask", "start", { failed: "409" });
    expect(failed).toEqual({
      open: true,
      asking: true,
      busy: false,
      failure: "409",
    });
    expect(menuStep(failed, "start").failure).toBeNull();
    expect(menuStep(failed, "keep")).toEqual({ ...CLOSED, open: true });
  });
});
