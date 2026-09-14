// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every tab of a project shares: the head with the name, the
// tabs, and the aside: About, then a team's members or, in a personal
// project, the agents as on Home. A tab's view puts its content under
// the tabs. The name is in the rail's list before the page's row
// arrives.

import type { ComponentChildren } from "preact";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { me } from "../../data/me.ts";
import { project, projectError, projects } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { longDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { aboutLine, plural, tabsOf } from "./Project.model.ts";
import "./projects.css";

export function Frame({
  id,
  tab,
  children,
}: {
  id: string;
  tab: "feed" | "members" | "settings";
  children: (shown: ProjectDetail) => ComponentChildren;
}) {
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  const listed = projects.value?.find((p) => p.id === id);
  const agents = projectAgents.value;
  const tabs = tabsOf(id, shown?.kind ?? listed?.kind ?? "team");
  const about = shown === null ? null : aboutLine(shown);
  return (
    <Page
      crumb="Projects"
      crumbHref="/projects"
      title={shown?.name ?? listed?.name ?? "Project"}
      loading={shown === null && projectError.value === null}
      error={projectError.value}
    >
      {shown && (
        <Split
          aside={
            <>
              <AsideSection label="About">
                {about !== null && <div class="split-line">{about}</div>}
                <div class="split-line">
                  Created
                  <span class="split-strong">{longDate(shown.createdAt)}</span>
                </div>
              </AsideSection>
              {shown.kind === "team" ? (
                <AsideSection label="Members">
                  <a class="split-line split-link" href={tabs[1].href}>
                    <span class="split-tile">
                      <Icon name="user" size={13} />
                    </span>
                    {plural(shown.members.length, "user")}
                  </a>
                  <a class="split-line split-link" href={tabs[1].href}>
                    <span class="split-tile">
                      <Icon name="agents" size={13} />
                    </span>
                    {agents === null ? "" : plural(agents.length, "agent")}
                  </a>
                </AsideSection>
              ) : (
                <AgentsAside
                  agents={agents}
                  admin={me.value?.role === "admin"}
                />
              )}
            </>
          }
        >
          <Tabs
            tabs={tabs}
            active={tab === "feed" ? tabs[0].href : `/projects/${id}/${tab}`}
          />
          {children(shown)}
        </Split>
      )}
    </Page>
  );
}
