// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Setup aside's lines for what a task keeps its runs from: nothing
// while everything is on.

import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { credentials, servers, skills } from "../../data/capabilities.ts";
import { AsideLine } from "../../ui/Split.tsx";
import { accessOf } from "./Access.model.ts";

export function AccessLines({ row }: { row: AutomationSummary }) {
  const access = accessOf(
    row,
    servers.value[row.agentId] ?? [],
    skills.value[row.agentId] ?? [],
    credentials.value,
  );
  return (
    <>
      {!access.web && <AsideLine label="Web access">Off</AsideLine>}
      {access.credentialsOff.length > 0 && (
        <AsideLine label="Credentials off">
          {access.credentialsOff.join(", ")}
        </AsideLine>
      )}
      {!access.visuals && <AsideLine label="Visuals">Off</AsideLine>}
      {access.mcpOff.length > 0 && (
        <AsideLine label="MCP off">{access.mcpOff.join(", ")}</AsideLine>
      )}
      {access.skillsOff.length > 0 && (
        <AsideLine label="Skills off">{access.skillsOff.join(", ")}</AsideLine>
      )}
    </>
  );
}
