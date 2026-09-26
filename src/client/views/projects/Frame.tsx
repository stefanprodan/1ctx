// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every tab of a project shares: the head with the name, the
// tabs, and the aside: About, then the project's recent weeks. The
// members and the agents are the Members tab's, and Home's. A tab's view puts its content under
// the tabs. The name and the kind are in the rail's list before the
// page's row arrives, so the head and the tabs are drawn at once.

import type { ComponentChildren } from "preact";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { automationCount } from "../../data/automations.ts";
import { knowledgeCount, knowledgeOf } from "../../data/knowledge.ts";
import { project, projectError, projects } from "../../data/projects.ts";
import { projectAgentCount } from "../../data/sessions.ts";
import { longDate } from "../../lib/format.ts";
import { Page, PageLoading } from "../../ui/Page.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { knowledgeWords } from "../knowledge/Knowledge.model.ts";
import { ActivityAside } from "./ActivityAside.tsx";
import { aboutLine, settledCounts, tabsOf } from "./Project.model.ts";
import "./projects.css";

export function Frame({
  id,
  tab,
  children,
}: {
  id: string;
  tab: "feed" | "automations" | "memory" | "knowledge" | "members" | "settings";
  children: (shown: ProjectDetail) => ComponentChildren;
}) {
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  const listed = projects.value?.find((p) => p.id === id);
  const kind = shown?.kind ?? listed?.kind ?? "team";
  const tabs = tabsOf(
    id,
    kind,
    settledCounts(kind, {
      automations: automationCount(id),
      knowledge: knowledgeCount(id),
      members: shown === null ? null : shown.members.length,
      agents: projectAgentCount(id),
    }),
  );
  const about = shown === null ? null : aboutLine(shown);
  // the list, once the tab loaded it, is fresher than the project row
  const knowledge = knowledgeOf(id)?.totals ??
    shown?.knowledge ?? { files: 0, tokens: 0 };
  return (
    <Page
      crumb="Projects"
      crumbHref="/projects"
      title={shown?.name ?? listed?.name ?? "Project"}
      loading={
        shown === null && listed === undefined && projectError.value === null
      }
      error={projectError.value}
    >
      {(shown !== null || listed !== undefined) && (
        <Split
          aside={
            shown !== null && (
              <>
                <AsideSection label="About">
                  {about !== null && <div class="split-line">{about}</div>}
                  {knowledge.files > 0 && (
                    <AsideLine label="Knowledge">
                      {knowledgeWords(knowledge)}
                    </AsideLine>
                  )}
                  <AsideLine label="Created">
                    {longDate(shown.createdAt)}
                  </AsideLine>
                </AsideSection>
                <ActivityAside projectId={shown.id} />
              </>
            )
          }
        >
          <Tabs
            tabs={tabs}
            active={tab === "feed" ? tabs[0].href : `/projects/${id}/${tab}`}
          />
          {shown === null ? <PageLoading /> : children(shown)}
        </Split>
      )}
    </Page>
  );
}
