// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every tab of a project shares: the head with the name, the
// kind line, and the tabs. A tab's view puts its content under it.
// The name is in the rail's list before the page's row arrives.

import type { ComponentChildren } from "preact";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { project, projectError, projects } from "../../data/projects.ts";
import { Page } from "../../ui/Page.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { kindText, tabsOf } from "./Project.model.ts";
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
  return (
    <Page
      crumb="Projects"
      crumbHref="/projects"
      title={shown?.name ?? listed?.name ?? "Project"}
      loading={shown === null && projectError.value === null}
      error={projectError.value}
    >
      {shown && (
        <div class="projects-one">
          <p class="projects-kind-text">{kindText(shown.kind)}</p>
          <Tabs tabs={tabs} active={tabs[tab === "feed" ? 0 : 1].href} />
          {children(shown)}
        </div>
      )}
    </Page>
  );
}
