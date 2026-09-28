// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { pluralCommas } from "../../lib/format.ts";

export function providerDeleteLine(agentCount: number, deciderCount: number) {
  if (agentCount === 0 && deciderCount === 0) return "Nothing runs on it.";
  const parts = [
    agentCount > 0 ? pluralCommas(agentCount, "agent", "agents") : "",
    deciderCount > 0 ? pluralCommas(deciderCount, "decider", "deciders") : "",
  ].filter((part) => part !== "");
  const one = agentCount + deciderCount === 1;
  return `${parts.join(" and ")} ${one ? "runs" : "run"} on it. Move ${
    one ? "it" : "them"
  } to another provider first.`;
}
