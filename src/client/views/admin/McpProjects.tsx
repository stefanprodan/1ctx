// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where an MCP server is offered: All team projects, or the team
// projects picked as on a credential's page (ProjectPicks.tsx), and the
// most a personal project gets. The new server's form draws the fields,
// the server's page its Access card, with the server's own switches.

import type {
  McpProject,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import { patchServer } from "../../data/mcp.ts";
import { projects } from "../../data/projects.ts";
import { at, type Save, useSave } from "../../lib/save.ts";
import { Labelled } from "../../ui/Labelled.tsx";
import { RowsList } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { teamsOf } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import {
  CEILING_LABEL,
  mcpFieldOf,
  OFFER_OPTIONS,
  offerOf,
  offerSides,
  type Personal,
  personalHint,
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
      label="Team projects"
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

// one card for who gets the server and how much: the team projects, the
// personal grant and the server's own switches, the most any project
// may use; one draft, saved in one PATCH
export function AccessCard({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    const s = latest.current;
    d.resetAccess(await patchServer(s.id, d.accessBody(s)));
  }, mcpFieldOf);
  const keyed = server.keyName !== null;
  const ids = d.projectIds.value;
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
        title="Access"
        foot={
          <DraftFoot
            save={save}
            dirty={d.accessDirty(server)}
            onDiscard={() => d.resetAccess(latest.current)}
          />
        }
      >
        <div class="mcp-page-access">
          <Labelled
            label="Team projects"
            field="projects"
            save={save}
            hint={reachHint(d.reach.value, ids, keyed)}
          >
            <ReachSeg
              reach={d.reach.value}
              save={save}
              onPick={(reach) => {
                d.reach.value = reach;
                save.touch();
              }}
            />
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
          </Labelled>
          <Labelled
            label="Personal projects"
            field="personal"
            save={save}
            hint={personalHint(d.personal.value, keyed)}
          >
            <PersonalSeg
              personal={d.personal.value}
              save={save}
              onPick={(personal) => {
                if (personal === "") return;
                d.personal.value = personal;
                save.touch();
              }}
            />
          </Labelled>
          <Labelled label={CEILING_LABEL} field="offer" save={save}>
            <Seg
              label={CEILING_LABEL}
              name="offer"
              value={offerOf(d.read.value, d.write.value)}
              options={OFFER_OPTIONS.map((o) => ({
                ...o,
                disabled: save.busy,
              }))}
              onPick={(offer) => {
                const sides = offerSides(offer);
                d.read.value = sides.read;
                d.write.value = sides.write;
                save.touch();
              }}
            />
          </Labelled>
        </div>
      </Setting>
    </SettingForm>
  );
}
