// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { webItem } from "../../../src/client/composer/Add.model.ts";
import { WEB } from "../../../src/shared/capabilities.ts";

describe("the Web access item", () => {
  test("is live and on when the instance allows it and the chat left it", () => {
    expect(webItem({ tools: true, switchable: [WEB], off: false })).toEqual({
      live: true,
      on: true,
      reason: null,
    });
  });

  test("is live and off once the chat turned it off", () => {
    expect(webItem({ tools: true, switchable: [WEB], off: true })).toEqual({
      live: true,
      on: false,
      reason: null,
    });
  });

  test("cannot be switched while an admin has it off, and says so", () => {
    expect(webItem({ tools: true, switchable: [], off: false })).toEqual({
      live: false,
      on: false,
      reason: "Turned off by an admin",
    });
  });

  test("an agent without tools comes before the admin's word", () => {
    expect(webItem({ tools: false, switchable: [WEB], off: false })).toEqual({
      live: false,
      on: false,
      reason: "Agent cannot use tools",
    });
    expect(webItem({ tools: false, switchable: [], off: false }).reason).toBe(
      "Agent cannot use tools",
    );
  });

  test("waits without a reason until the project's agents answered", () => {
    expect(webItem({ tools: true, switchable: null, off: false })).toEqual({
      live: false,
      on: false,
      reason: null,
    });
  });
});
