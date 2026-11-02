// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where an MCP server is offered: All projects, or the team projects
// picked as on a credential's page (ProjectPicks.tsx). The new server's
// form and the server's page draw it.

import type { McpProject } from "../../../shared/contracts/mcp.ts";
import { projects } from "../../data/projects.ts";
import type { Save } from "../../lib/save.ts";
import { RowsList } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { teamsOf } from "./Credentials.model.ts";
import { REACH_OPTIONS, type Reach } from "./Mcp.model.ts";
import { AddProject, ProjectRows } from "./ProjectPicks.tsx";

export type ProjectsPick = { reach: Reach; projectIds: string[] };

export function ReachSeg({
  reach,
  save,
  onPick,
}: {
  reach: Reach;
  save: Save;
  onPick: (reach: Reach) => void;
}) {
  return (
    <Seg
      label="Projects"
      name="projects"
      value={reach}
      invalid={save.fieldError("projects") !== null}
      options={REACH_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
      onPick={onPick}
    />
  );
}

// the picked team projects and Add project under them; a project the
// server lists that the list no longer holds stays, so it can go
export function ProjectsPicks({
  projectIds,
  held,
  save,
  onChange,
}: {
  projectIds: string[];
  held: readonly McpProject[];
  save: Save;
  onChange: (projectIds: string[]) => void;
}) {
  const teams = teamsOf(projects.value ?? [], { projects: [...held] });
  return (
    <div class="mcp-page-picks">
      {projectIds.length > 0 && (
        <RowsList>
          <ProjectRows
            teams={teams}
            value={projectIds}
            save={save}
            onChange={onChange}
          />
        </RowsList>
      )}
      {projects.value !== null && (
        <div class="mcp-page-add">
          <AddProject
            teams={teams}
            value={projectIds}
            disabled={save.busy}
            align="left"
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}
