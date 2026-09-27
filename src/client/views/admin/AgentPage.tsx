// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's page under Config: the crumb is the head, its own step the
// switcher to the other agents; a line over the tabs only when a server
// or a skill of the agent is failing, each count opening its tab; then
// the tabs General, Skills and MCP, one view for the three so the
// drafts outlive a tab switch. The aside has the agent's last 30 days
// and the chats and scheduled tasks on it.

import { useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import { agents, agentsError, facts } from "../../data/agents.ts";
import { servers } from "../../data/mcp.ts";
import { providersError } from "../../data/providers.ts";
import { skills } from "../../data/skills.ts";
import { count, pluralCommas } from "../../lib/format.ts";
import { type AgentTab, configAgentHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Page } from "../../ui/Page.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { AgentGeneral } from "./AgentGeneral.tsx";
import { AgentMcp } from "./AgentMcp.tsx";
import { failing } from "./AgentPage.model.ts";
import { AgentDrafts } from "./AgentPage.state.ts";
import { AgentSkills } from "./AgentSkills.tsx";
import { money } from "./Overview.model.ts";
import "./agent-page.css";

const STEPS = [
  { label: "Config" },
  { label: "Agents", href: "/config/agents" },
];

const TABS: { tab: AgentTab; label: string }[] = [
  { tab: "general", label: "General" },
  { tab: "skills", label: "Skills" },
  { tab: "mcp", label: "MCP" },
];

// the step after the name, so an agent named mcp opens on General
export function tabOf(pathname: string): AgentTab {
  const tab = pathname.split("/")[4];
  return tab === "skills" || tab === "mcp" ? tab : "general";
}

export function AgentPage({ params }: { params: Params }) {
  const list = agents.value;
  // the agent on screen by its id too: a rename or a delete changes the
  // list a moment before the address follows
  // while the address still names it
  const shown = useRef<{ id: string; name: string } | null>(null);
  const held = shown.current?.name === params.name ? shown.current : null;
  const agent =
    list?.find((a) => a.name === params.name) ??
    list?.find((a) => a.id === held?.id) ??
    null;
  const leaving = agent === null && held !== null;
  if (agent !== null && agent.name === params.name) {
    shown.current = { id: agent.id, name: agent.name };
  }
  const error = agentsError.value ?? providersError.value;
  const missing = list !== null && agent === null && !leaving;
  // one set of drafts per agent: a pick of another starts afresh
  const drafts = useRef<AgentDrafts | null>(null);
  const row = useRef<AgentSummary | null>(null);
  if (agent !== null && drafts.current?.agentId !== agent.id) {
    drafts.current = AgentDrafts.of(agent);
  } else if (agent !== null && row.current !== null && row.current !== agent) {
    drafts.current?.follow(row.current, agent);
  }
  row.current = agent;
  const tab = tabOf(path.value);
  return (
    <Page
      steps={STEPS}
      title={`@${params.name}`}
      menu={agent !== null ? <Switcher agent={agent} tab={tab} /> : undefined}
      split
      loading={list === null && error === null}
      empty={missing ? "No agent by that name." : undefined}
      error={error}
    >
      {agent !== null && drafts.current !== null && (
        <Split aside={<Aside agent={agent} />}>
          <Body
            key={agent.id}
            agent={agent}
            tab={tab}
            drafts={drafts.current}
          />
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other agents, by name, a pick opening its
// page on the same tab
function Switcher({ agent, tab }: { agent: AgentSummary; tab: AgentTab }) {
  const list = byName(agents.value ?? []);
  const name = `@${agent.name}`;
  if (list.length < 2) return <span class="page-crumb-on">{name}</span>;
  return (
    <Finder
      label="Agents"
      triggerClass="page-pill"
      title={name}
      trigger={
        <>
          <span class="cut">{name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((a) => ({
        value: a.id,
        label: `@${a.name}`,
        href: configAgentHref(a.name, tab),
      }))}
      value={agent.id}
      mono
      wide
      placeholder="Find an agent"
      none="No agent matches"
    />
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
    <div class="agent-page">
      {(bad.servers > 0 || bad.skills > 0) && (
        <p class="agent-page-bad" role="status">
          <Icon name="alert" size={16} class="agent-page-bad-icon" />
          {bad.servers > 0 && (
            <a
              class="agent-page-bad-link"
              href={configAgentHref(agent.name, "mcp")}
            >
              {pluralCommas(bad.servers, "MCP server", "MCP servers")}
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
        </p>
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
    </div>
  );
}

function Aside({ agent }: { agent: AgentSummary }) {
  const known = facts.value?.agentId === agent.id ? facts.value : null;
  const usage = known?.usage ?? null;
  const impact = known?.impact ?? null;
  return (
    <>
      <AsideSection
        label="Last 30 days"
        action={
          <a class="split-link" href="/admin">
            Usage
          </a>
        }
      >
        {known === null ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Turns">{count(usage.sends)}</AsideLine>
            <AsideLine label="Tokens">{count(usage.tokens)}</AsideLine>
            <AsideLine label="Cost">
              {usage.cost === null ? "not priced" : money(usage.cost)}
            </AsideLine>
          </>
        )}
      </AsideSection>
      <AsideSection label="Used in">
        {known === null ? (
          <p class="split-empty">Loading</p>
        ) : impact === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Chats">{count(impact.chats)}</AsideLine>
            <AsideLine label="Scheduled tasks">
              {count(impact.automations)}
            </AsideLine>
          </>
        )}
      </AsideSection>
    </>
  );
}
