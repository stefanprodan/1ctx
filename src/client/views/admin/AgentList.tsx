// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { shortModel } from "../../agents/meta.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  activity,
  agents,
  agentsError,
  loadAgents,
} from "../../data/agents.ts";
import { servers } from "../../data/mcp.ts";
import { providers, providersError } from "../../data/providers.ts";
import { skills } from "../../data/skills.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import {
  AGENTS_HREF,
  configAgentHref,
  PROVIDERS_HREF,
} from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { byName, countOf, useListSearch } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Fit } from "../../ui/Fit.tsx";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTag,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { overviewTotals, SpendLines, UsageSection } from "./AdminAside.tsx";
import { failing, failingLine, lastUse } from "./AgentPage.model.ts";
import { NewAgent } from "./NewAgent.tsx";
import { costOf, tokensOf } from "./Overview.model.ts";
import "./agent-list.css";

export function AgentList() {
  if (new URLSearchParams(query.value).has("new")) return <NewAgent />;
  return <List />;
}

function List() {
  const list = agents.value;
  const rows = providers.value;
  const provider = useSignal("");
  const now = useNow(60_000);
  // read on open and on focus, never polled
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") void loadAgents();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, []);
  const providerName = (a: AgentSummary) =>
    rows?.find((p) => p.id === a.providerId)?.name ?? "";
  const all = byName(list ?? []);
  const using = byName(rows ?? [])
    .map((p) => ({
      ...p,
      agents: all.filter((a) => a.providerId === p.id).length,
    }))
    .filter((p) => p.agents > 0);
  const picked = using.find((p) => p.id === provider.value) ?? null;
  const { q, shown } = useListSearch(
    picked === null ? all : all.filter((a) => a.providerId === picked.id),
    (a) => [a.name, a.model.id, providerName(a)],
  );
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Agents"
      split
      actions={<PageNew href={`${AGENTS_HREF}?new`} label="New agent" />}
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Split aside={<Aside using={using} />}>
        <Rows>
          <RowsCard
            label="Agents"
            wrap
            search={<Search query={q} placeholder="Search agents" />}
            count={countOf(shown.length, all.length)}
            action={
              using.length > 1 && (
                <Finder
                  label="Providers"
                  triggerClass="btn btn-small agent-list-pick"
                  title={picked?.name}
                  trigger={
                    <>
                      <span class="agent-list-pick-key">Provider</span>
                      <span class="agent-list-pick-value">
                        {picked?.name ?? "All"}
                      </span>
                      <Icon
                        name="chevron"
                        size={14}
                        class="agent-list-pick-chevron"
                      />
                    </>
                  }
                  lead={{ value: "", label: "All providers" }}
                  options={using.map((p) => ({ value: p.id, label: p.name }))}
                  value={provider.value}
                  mono
                  align="right"
                  placeholder="Find a provider"
                  none="No provider matches"
                  onPick={(value) => {
                    provider.value = value;
                  }}
                />
              )
            }
          >
            {all.length === 0 && (
              <RowsNote>
                {rows?.length === 0
                  ? "No agents yet. Add a provider first, then make the first agent on one of its models."
                  : "No agents yet. New agent picks a model from a provider."}
              </RowsNote>
            )}
            {all.length > 0 && shown.length === 0 && (
              <RowsNote>No agent matches.</RowsNote>
            )}
            {shown.map((a) => (
              <Row key={a.id} agent={a} provider={providerName(a)} now={now} />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}

function Row({
  agent,
  provider,
  now,
}: {
  agent: AgentSummary;
  provider: string;
  now: number;
}) {
  const use = lastUse(
    activity.value.find((a) => a.agentId === agent.id),
    now,
  );
  const bad = failingLine(failing(agent, servers.value, skills.value));
  return (
    <RowsGo href={configAgentHref(agent.name)}>
      <RowsAvatar>
        <AvatarIcon name={agent.avatar} size={15} />
      </RowsAvatar>
      <RowsTitle
        mono
        name={
          <>
            <span class="cut">@{agent.name}</span>
            {agent.default && <RowsTag>default</RowsTag>}
          </>
        }
        sub={
          <span class="agent-list-sub">
            <Fit
              class="agent-list-model cut"
              long={agent.model.id}
              short={shortModel(agent.model.id)}
            />
            {bad !== "" && <span class="agent-list-bad">{bad}</span>}
          </span>
        }
      />
      <RowsMeta
        keep
        under={
          <span class="agent-list-provider cut" title={provider}>
            {provider}
          </span>
        }
      >
        <span class={use.running ? "agent-list-running" : undefined}>
          {use.text}
        </span>
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ using }: { using: { name: string; agents: number }[] }) {
  return (
    <>
      <UsageSection value={overviewTotals()}>
        {(totals) => (
          <SpendLines
            label="Turns"
            count={totals.turns + totals.runs}
            tokens={tokensOf(totals)}
            cost={costOf(totals)}
          />
        )}
      </UsageSection>
      <AsideSection
        label="Providers"
        action={
          <a class="split-link" href={PROVIDERS_HREF}>
            Manage
          </a>
        }
      >
        {using.length === 0 ? (
          <p class="split-empty">None yet.</p>
        ) : (
          using.map((p) => (
            <AsideLine key={p.name} label={p.name}>
              {p.agents}
            </AsideLine>
          ))
        )}
      </AsideSection>
    </>
  );
}
