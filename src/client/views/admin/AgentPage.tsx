// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError, factsFor } from "../../data/agents.ts";
import { servers } from "../../data/mcp.ts";
import { providersError } from "../../data/providers.ts";
import { skills } from "../../data/skills.ts";
import { count, pluralCommas } from "../../lib/format.ts";
import {
  AGENTS_HREF,
  type AgentTab,
  configAgentHref,
} from "../../lib/hrefs.ts";
import { byName } from "../../lib/search.ts";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { SettingAlert, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, AsideRead, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import { AgentGeneral } from "./AgentGeneral.tsx";
import { AgentMcp } from "./AgentMcp.tsx";
import { failing } from "./AgentPage.model.ts";
import { AgentDrafts } from "./AgentPage.state.ts";
import { AgentSkills } from "./AgentSkills.tsx";
import { useRowDrafts, useShownRow } from "./drafts.ts";
import "./agent-page.css";

const STEPS = [zoneStep("Config"), { label: "Agents", href: AGENTS_HREF }];

const TABS: { tab: AgentTab; label: string }[] = [
  { tab: "general", label: "General" },
  { tab: "skills", label: "Skills" },
  { tab: "mcp", label: "MCP" },
];

// the step after the name, so an agent named mcp opens on General
export function tabOf(pathname: string): AgentTab {
  const tab = pathname.split("/")[5];
  return tab === "skills" || tab === "mcp" ? tab : "general";
}

export function AgentPage({ params }: { params: Params }) {
  const list = agents.value;
  const { row: agent, leaving } = useShownRow(list, params.name, (a) => a.name);
  const error = agentsError.value ?? providersError.value;
  const missing = list !== null && agent === null && !leaving;
  const drafts = useRowDrafts(agent, AgentDrafts.of, (d, before, after) =>
    d.follow(before, after),
  );
  const tab = tabOf(path.value);
  return (
    <Page
      steps={STEPS}
      title={`@${params.name}`}
      menu={
        agent !== null ? (
          <PageSwitcher
            label="Agents"
            current={agent.id}
            name={`@${agent.name}`}
            items={byName(list ?? []).map((a) => ({
              id: a.id,
              label: `@${a.name}`,
              href: configAgentHref(a.name, tab),
            }))}
            placeholder="Find an agent"
            none="No agent matches"
          />
        ) : undefined
      }
      split
      loading={list === null && error === null}
      empty={missing ? "No agent by that name." : undefined}
      error={error}
    >
      {agent !== null && drafts !== null && (
        <Split aside={<Aside agent={agent} />}>
          <Body key={agent.id} agent={agent} tab={tab} drafts={drafts} />
        </Split>
      )}
    </Page>
  );
}

function Body({
  agent,
  tab,
  drafts,
}: {
  agent: AgentSummary;
  tab: AgentTab;
  drafts: AgentDrafts;
}) {
  const bad = failing(agent, servers.value, skills.value);
  return (
    <SettingStack>
      {(bad.servers > 0 || bad.skills > 0) && (
        <SettingAlert>
          {bad.servers > 0 && (
            <a
              class="agent-page-bad-link"
              href={configAgentHref(agent.name, "mcp")}
            >
              {pluralCommas(bad.servers, "MCP Server", "MCP Servers")}
            </a>
          )}
          {bad.servers > 0 && bad.skills > 0 && ", "}
          {bad.skills > 0 && (
            <a
              class="agent-page-bad-link"
              href={configAgentHref(agent.name, "skills")}
            >
              {pluralCommas(bad.skills, "skill", "skills")}
            </a>
          )}{" "}
          failing
        </SettingAlert>
      )}
      <Tabs
        tabs={TABS.map((t) => ({
          label: t.label,
          href: configAgentHref(agent.name, t.tab),
          count:
            t.tab === "skills"
              ? agent.skills.length
              : t.tab === "mcp"
                ? agent.servers.length
                : undefined,
        }))}
        active={configAgentHref(agent.name, tab)}
      />
      {tab === "general" && <AgentGeneral agent={agent} drafts={drafts} />}
      {tab === "skills" && <AgentSkills agent={agent} drafts={drafts} />}
      {tab === "mcp" && <AgentMcp agent={agent} drafts={drafts} />}
    </SettingStack>
  );
}

function Aside({ agent }: { agent: AgentSummary }) {
  const facts = factsFor(agent.id);
  return (
    <>
      <UsageSection
        value={facts === undefined ? undefined : (facts?.usage ?? null)}
      >
        {(usage) => (
          <SpendLines
            label="Turns"
            count={usage.sends}
            tokens={usage.tokens}
            cost={usage.cost}
          />
        )}
      </UsageSection>
      <AsideRead
        label="Used in"
        value={facts === undefined ? undefined : (facts?.impact ?? null)}
      >
        {(impact) => (
          <>
            <AsideLine label="Chats">{count(impact.chats)}</AsideLine>
            <AsideLine label="Scheduled tasks">
              {count(impact.automations)}
            </AsideLine>
          </>
        )}
      </AsideRead>
    </>
  );
}
