// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Setup aside's lines for what a task keeps its runs from: nothing
// while everything is on.

import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { servers } from "../../data/capabilities.ts";
import { accessOf } from "./Automations.model.ts";

export function AccessLines({ row }: { row: AutomationSummary }) {
  const access = accessOf(row, servers.value[row.agentId] ?? []);
  return (
    <>
      {!access.web && (
        <div class="split-line">
          Web access
          <span class="split-strong">Off</span>
        </div>
      )}
      {access.mcpOff.length > 0 && (
        <div class="split-line">
          MCP off
          <span class="split-strong">{access.mcpOff.join(", ")}</span>
        </div>
      )}
    </>
  );
}
