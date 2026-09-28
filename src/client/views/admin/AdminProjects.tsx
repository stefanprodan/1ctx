// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  adminProjects,
  adminProjectsError,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { count, sinceLine } from "../../lib/format.ts";
import { adminProjectHref, PROJECTS_HREF } from "../../lib/hrefs.ts";
import { useListSearch } from "../../lib/search.ts";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { countLine } from "./AdminProjects.model.ts";
import { NewProject } from "./NewProject.tsx";

export function AdminProjects() {
  if (new URLSearchParams(query.value).has("new")) return <NewProject />;
  return <List />;
}

function List() {
  const list = adminProjects.value;
  const error = adminProjectsError.value;
  const { q, shown, count } = useListSearch(list ?? [], (p) => [p.name]);
  return (
    <Page
      steps={[zoneStep("Access")]}
      title="Projects"
      split
      actions={<PageNew href={`${PROJECTS_HREF}?new`} label="New project" />}
      loading={list === null && error === null}
      error={error}
    >
      {list !== null && (
        <Split
          aside={
            <ProjectCountsSection
              teams={list}
              users={users.value}
              failed={usersError.value !== null}
            />
          }
        >
          <RowsCard
            label="Projects"
            search={<Search query={q} placeholder="Search projects" />}
            count={count}
          >
            {list.length === 0 ? (
              <RowsNote>No team projects yet.</RowsNote>
            ) : (
              shown.length === 0 && <RowsNote>No project matches.</RowsNote>
            )}
            {shown.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </RowsCard>
        </Split>
      )}
    </Page>
  );
}

export function ProjectRow({ project: p }: { project: ProjectSummary }) {
  return (
    <RowsGo href={adminProjectHref(p.id)}>
      <RowsTitle name={p.name} sub={countLine(p)} mono />
      <RowsMeta>{sinceLine(p)}</RowsMeta>
    </RowsGo>
  );
}

// every user has a personal project
export function ProjectCountsSection({
  teams,
  users,
  failed,
}: {
  teams: readonly ProjectSummary[];
  users: readonly AdminUser[] | null;
  failed?: boolean;
}) {
  return (
    <AsideSection label="Projects">
      <AsideLine label="Team">{count(teams.length)}</AsideLine>
      <AsideLine label="Personal">
        {users !== null ? count(users.length) : failed ? "Did not load." : ""}
      </AsideLine>
    </AsideSection>
  );
}
