// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { FADE, scrollTo } from "../../../src/client/ui/Tabs.tsx";

describe("a phone's tab row scrolls the open tab into view", () => {
  test("a tab past the end comes clear of the fade at the right", () => {
    expect(scrollTo(0, 358, { left: 370, width: 52 })).toBe(
      370 + 52 + FADE - 358,
    );
  });

  test("a tab before the start comes clear of the fade at the left", () => {
    expect(scrollTo(200, 358, { left: 120, width: 52 })).toBe(120 - FADE);
  });

  test("the first tab scrolls to the start, never before it", () => {
    expect(scrollTo(64, 358, { left: 0, width: 33 })).toBe(0);
  });

  test("a tab whole but under a fade still moves clear of it", () => {
    expect(scrollTo(0, 358, { left: 300, width: 52 })).toBe(
      300 + 52 + FADE - 358,
    );
  });

  test("a tab clear of both fades leaves the row where it is", () => {
    expect(scrollTo(0, 358, { left: 120, width: 52 })).toBe(0);
    expect(scrollTo(96, 358, { left: 370, width: 52 })).toBe(96);
  });
});
