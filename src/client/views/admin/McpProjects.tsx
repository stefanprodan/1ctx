// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where an MCP server is offered: All team projects, or the team
// projects picked as on a credential's page (ProjectPicks.tsx), and the
// most a personal project gets. The new server's form draws the fields,
// the server's page their cards.

import type {
  McpProject,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import { patchServer } from "../../data/mcp.ts";
import { projects } from "../../data/projects.ts";
import { at, type Save, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { RowsList } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { teamsOf } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import {
  mcpFieldOf,
  OFFER_OPTIONS,
  type Personal,
  personalHint,
  projectsBody,
  projectsProblem,
  REACH_OPTIONS,
  type Reach,
  reachHint,
} from "./Mcp.model.ts";
import type { McpDrafts } from "./McpPage.state.ts";
import { AddProject, ProjectRows } from "./ProjectPicks.tsx";

type Props = { server: McpServerSummary; drafts: McpDrafts };

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

export function PersonalSeg({
  personal,
  save,
  onPick,
}: {
  personal: Personal;
  save: Save;
  onPick: (personal: Personal) => void;
}) {
  return (
    <Seg<Personal>
      label="Personal projects"
      name="personal"
      value={personal}
      invalid={save.fieldError("personal") !== null}
      options={OFFER_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
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

// beside the endpoint, so an admin adding a key sees where it reaches
export function ProjectsCard({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    d.resetProjects(
      await patchServer(latest.current.id, {
        projects: projectsBody(d.reach.value, d.projectIds.value),
      }),
    );
  }, mcpFieldOf);
  const ids = d.projectIds.value;
  const refused = save.fieldError("projects");
  return (
    <SettingForm
      save={save}
      check={() =>
        at(
          "projects",
          projectsProblem(
            latest.current.keyName !== null,
            d.reach.value,
            d.projectIds.value,
          ),
        )
      }
    >
      <Setting
        title="Projects"
        line={reachHint(d.reach.value, ids, server.keyName !== null)}
        action={
          <ReachSeg
            reach={d.reach.value}
            save={save}
            onPick={(reach) => {
              d.reach.value = reach;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={d.projectsDirty(server)}
            hint={
              refused !== null ? (
                <FieldError save={save} field="projects" />
              ) : undefined
            }
            onDiscard={() => d.resetProjects(latest.current)}
          />
        }
      >
        {d.reach.value === "picked" && (
          <ProjectsPicks
            projectIds={ids}
            held={server.projects}
            save={save}
            onChange={(projectIds) => {
              d.projectIds.value = projectIds;
              save.touch();
            }}
          />
        )}
      </Setting>
    </SettingForm>
  );
}

export function PersonalCard({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    d.resetPersonal(
      await patchServer(latest.current.id, { personal: d.personal.value }),
    );
  }, mcpFieldOf);
  return (
    <SettingForm save={save}>
      <Setting
        title="Personal projects"
        line={
          personalHint(d.personal.value, server.keyName !== null) ??
          "The most a personal project may choose."
        }
        action={
          <PersonalSeg
            personal={d.personal.value}
            save={save}
            onPick={(personal) => {
              if (personal === "") return;
              d.personal.value = personal;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={d.personalDirty(server)}
            hint={
              save.fieldError("personal") !== null ? (
                <FieldError save={save} field="personal" />
              ) : undefined
            }
            onDiscard={() => d.resetPersonal(latest.current)}
          />
        }
      />
    </SettingForm>
  );
}
