// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Setup aside's lines for what an automation keeps its runs from: nothing
// while everything is on.

import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { switchablesOf } from "../../data/capabilities.ts";
import { AsideLine, AsideNames } from "../../ui/Split.tsx";
import { accessOf } from "./Access.model.ts";

export function AccessLines({ row }: { row: AutomationSummary }) {
  const access = accessOf(row, switchablesOf(row.agentId));
  return (
    <>
      {!access.web && <AsideLine label="Web access">Off</AsideLine>}
      {access.credentialsOff.length > 0 && (
        <AsideLine label="Credentials off">
          <AsideNames names={access.credentialsOff} />
        </AsideLine>
      )}
      {!access.visuals && <AsideLine label="Visuals">Off</AsideLine>}
      {!access.knowledge && <AsideLine label="Knowledge">Off</AsideLine>}
      {!access.email && <AsideLine label="Email">Off</AsideLine>}
      {access.mcpOff.length > 0 && (
        <AsideLine label="MCP off">
          <AsideNames names={access.mcpOff} />
        </AsideLine>
      )}
      {access.skillsOff.length > 0 && (
        <AsideLine label="Skills off">
          <AsideNames names={access.skillsOff} />
        </AsideLine>
      )}
      {access.reposOff.length > 0 && (
        <AsideLine label="Repositories off">
          <AsideNames names={access.reposOff} />
        </AsideLine>
      )}
    </>
  );
}
