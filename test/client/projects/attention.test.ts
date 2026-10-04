// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The editor's Needs attention step: Agent needs a model that calls
// tools, Decider the instance's decider, and the hint says
// why a mode cannot be picked.

import { describe, expect, test } from "bun:test";
import {
  ATTENTION_LABELS,
  attentionHint,
  attentionOptions,
  guidanceShown,
} from "../../../src/client/views/projects/Attention.model.ts";

const disabled = (input: Parameters<typeof attentionOptions>[0]) =>
  attentionOptions(input)
    .filter((option) => option.disabled)
    .map((option) => option.value);

describe("the attention modes", () => {
  test("are drawn in order with their labels", () => {
    expect(
      attentionOptions({ takesTools: true, deciderOn: true, off: false }).map(
        (option) => option.label,
      ),
    ).toEqual(["Off", "Agent", "Decider"]);
    expect(ATTENTION_LABELS.decider).toBe("Decider");
  });

  test("disable what the agent or the instance cannot do", () => {
    expect(disabled({ takesTools: true, deciderOn: true, off: false })).toEqual(
      [],
    );
    expect(
      disabled({ takesTools: true, deciderOn: false, off: false }),
    ).toEqual(["decider"]);
    expect(
      disabled({ takesTools: false, deciderOn: true, off: false }),
    ).toEqual(["agent"]);
    expect(disabled({ takesTools: true, deciderOn: true, off: true })).toEqual([
      "off",
      "agent",
      "decider",
    ]);
  });

  test("show the words on when only where something reads them", () => {
    expect(guidanceShown({ mode: "off", takesTools: true })).toBe(false);
    expect(guidanceShown({ mode: "agent", takesTools: true })).toBe(true);
    expect(guidanceShown({ mode: "agent", takesTools: false })).toBe(false);
    expect(guidanceShown({ mode: "decider", takesTools: false })).toBe(true);
  });

  test("hint at the agent's model first, then the decider", () => {
    expect(attentionHint({ takesTools: true, deciderOn: true })).toBeNull();
    expect(attentionHint({ takesTools: false, deciderOn: false })).toBe(
      "This agent does not call tools, so it cannot mark its runs. The decider is off.",
    );
    expect(attentionHint({ takesTools: true, deciderOn: false })).toBe(
      "The decider is off.",
    );
    expect(attentionHint({ takesTools: false, deciderOn: true })).toBe(
      "This agent does not call tools, so it cannot mark its runs.",
    );
  });
});
