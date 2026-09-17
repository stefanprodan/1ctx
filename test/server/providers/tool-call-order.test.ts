// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ToolCallTracker } from "../../../src/server/providers/openai.ts";
import orders from "../../fixtures/providers/tool-call-order.json";

describe("tool call identity", () => {
  for (const fixture of orders) {
    test(fixture.name, () => {
      const tracker = new ToolCallTracker();
      const tracked = fixture.deltas.map((delta) =>
        tracker.push({ kind: "toolCallDelta", ...delta }),
      );
      expect(tracked.map((delta) => delta.callIndex)).toEqual(fixture.indexes);
      expect(tracker.flush()).toEqual(fixture.calls);
      for (const [at, delta] of fixture.deltas.entries()) {
        if (delta.name !== undefined) {
          expect(tracked[at]?.name).toBe(delta.name);
        }
      }
      expect(tracker.flush()).toEqual(fixture.calls);
    });
  }
});
