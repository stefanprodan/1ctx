// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every tab of a project shares: the head with the name, the
// kind line, the tabs, and the About card at the right with the facts
// the row carries. A tab's view puts its content under the tabs. The
// name is in the rail's list before the page's row arrives.

import type { ComponentChildren } from "preact";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { project, projectError, projects } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { initials, longDate } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import { AsideCard, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { kindLine, plural, tabsOf } from "./Project.model.ts";
import "./projects.css";

export function Frame({
  id,
  tab,
  children,
}: {
  id: string;
  tab: "feed" | "members";
  children: (shown: ProjectDetail) => ComponentChildren;
}) {
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  const listed = projects.value?.find((p) => p.id === id);
  // the users are on the row; the agents are counted with them once
  // membership makes that number the project's own
  const tabs = tabsOf(id, shown?.members.length ?? null);
  const agents = projectAgents.value;
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
            <AsideCard label="About">
              <div class="split-fact">
                <span>Kind</span>
                <span class="split-fact-value">{kindLine(shown.kind)}</span>
              </div>
              <div class="split-fact">
                <span>Created</span>
                <span class="split-fact-value">
                  {longDate(shown.createdAt)}
                </span>
              </div>
              <div class="split-fact">
                <span class="split-faces">
                  {shown.members.slice(0, 5).map((m) => (
                    <span key={m.id} class="split-face" title={m.fullName}>
                      {initials(m.fullName)}
                    </span>
                  ))}
                </span>
                <a class="split-fact-link" href={tabs[1].href}>
                  {plural(shown.members.length, "member")}
                </a>
              </div>
              <div class="split-fact">
                <span>Agents</span>
                <a class="split-fact-link" href={tabs[1].href}>
                  {agents === null ? "" : plural(agents.length, "agent")}
                </a>
              </div>
            </AsideCard>
          }
        >
          <Tabs tabs={tabs} active={tabs[tab === "feed" ? 0 : 1].href} />
          {children(shown)}
        </Split>
      )}
    </Page>
  );
}
