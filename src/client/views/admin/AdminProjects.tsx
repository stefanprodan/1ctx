// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access › Projects: one card of links, a row per team project by name,
// the member count under it and since when at the right. New project is
// in the page's head and opens its own page; a row opens the project's
// page. Personal projects are counted in the aside, never listed.

import { useSignal } from "@preact/signals";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  adminProjects,
  adminProjectsError,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { count, sinceLine } from "../../lib/format.ts";
import { adminProjectHref, PROJECTS_HREF } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
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
  const q = useSignal("");
  const all = list ?? [];
  const shown = all.filter((p) => matches(q.value, [p.name]));
  return (
    <Page
      steps={[zoneStep("Access")]}
      title="Projects"
      split
      actions={
        <a class="btn btn-small" href={`${PROJECTS_HREF}?new`}>
          <Icon name="plus" size={14} />
          New project
        </a>
      }
      loading={list === null && error === null}
      error={error}
    >
      {list !== null && (
        <Split aside={<Aside />}>
          <RowsCard
            label="Projects"
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search projects"
              />
            }
            count={
              shown.length !== all.length
                ? `${shown.length} of ${all.length}`
                : String(all.length)
            }
          >
            {all.length === 0 ? (
              <RowsNote>No team projects yet.</RowsNote>
            ) : (
              shown.length === 0 && <RowsNote>No project matches.</RowsNote>
            )}
            {shown.map((p) => (
              <RowsGo key={p.id} href={adminProjectHref(p.id)}>
                <RowsTitle name={p.name} sub={countLine(p)} mono />
                <RowsMeta>{sinceLine(p)}</RowsMeta>
              </RowsGo>
            ))}
          </RowsCard>
        </Split>
      )}
    </Page>
  );
}

// every user has a personal project, so the users count them
function Aside() {
  const people = users.value;
  const failed = usersError.value !== null;
  return (
    <AsideSection label="Projects">
      <AsideLine label="Team">
        {count(adminProjects.value?.length ?? 0)}
      </AsideLine>
      <AsideLine label="Personal">
        {people !== null ? count(people.length) : failed ? "Did not load." : ""}
      </AsideLine>
    </AsideSection>
  );
}
