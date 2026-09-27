// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Agents: a list of links, one row per agent in name order,
// each the avatar, the name and "default", the model under it, when it
// last ran and its provider at the right, and a line of what is failing
// when something is. The head searches the name, the model and the
// provider, counts the rows and filters by provider through a picker
// of the providers that have agents. The aside has the instance's last
// 30 days and the providers with their agent counts. `?new` is the New
// agent page.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { shortModel } from "../../agents/meta.ts";
import { query } from "../../app/router.ts";
import {
  activity,
  agents,
  agentsError,
  loadAgents,
} from "../../data/agents.ts";
import { servers } from "../../data/mcp.ts";
import { overview } from "../../data/overview.ts";
import { providers, providersError } from "../../data/providers.ts";
import { skills } from "../../data/skills.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { count } from "../../lib/format.ts";
import { configAgentHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { byName, matches } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Fit } from "../../ui/Fit.tsx";
import { Page } from "../../ui/Page.tsx";
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
import { failing, failingLine, lastUse } from "./AgentPage.model.ts";
import { NewAgent } from "./NewAgent.tsx";
import { costOf, money, tokensOf } from "./Overview.model.ts";
import "./agent-list.css";

const CONFIG = [{ label: "Config", href: "/config" }];

export function AgentList() {
  if (new URLSearchParams(query.value).has("new")) return <NewAgent />;
  return <List />;
}

function List() {
  const list = agents.value;
  const rows = providers.value;
  const q = useSignal("");
  const provider = useSignal("");
  const now = useNow(60_000);
  // the last use is read when the page opens or is seen again, never
  // polled
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
  // the providers that have agents, by name, each with its count
  const using = byName(rows ?? [])
    .map((p) => ({
      ...p,
      agents: all.filter((a) => a.providerId === p.id).length,
    }))
    .filter((p) => p.agents > 0);
  const picked = using.find((p) => p.id === provider.value) ?? null;
  const shown = all.filter(
    (a) =>
      (picked === null || a.providerId === picked.id) &&
      matches(q.value, [a.name, a.model.id, providerName(a)]),
  );
  const filtered = shown.length !== all.length;
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      steps={CONFIG}
      title="Agents"
      split
      actions={
        <a class="btn btn-small" href="/config/agents?new">
          <Icon name="plus" size={14} />
          New agent
        </a>
      }
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Split aside={<Aside using={using} />}>
        <Rows>
          <RowsCard
            label="Agents"
            wrap
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search agents"
              />
            }
            count={
              all.length === 0
                ? undefined
                : filtered
                  ? `${shown.length} of ${all.length}`
                  : String(all.length)
            }
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
      <RowsMeta keep>
        <span class="agent-list-meta">
          <span
            class={`agent-list-use${use.running ? " agent-list-running" : ""}`}
          >
            {use.text}
          </span>
          <span class="agent-list-provider cut" title={provider}>
            {provider}
          </span>
        </span>
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ using }: { using: { name: string; agents: number }[] }) {
  const totals = overview.value?.totals ?? null;
  const cost = totals === null ? null : costOf(totals);
  return (
    <>
      <AsideSection
        label="Last 30 days"
        action={
          <a class="split-link" href="/monitor">
            Usage
          </a>
        }
      >
        {totals === null ? (
          <p class="split-empty">Loading</p>
        ) : (
          <>
            <AsideLine label="Turns">
              {count(totals.turns + totals.runs)}
            </AsideLine>
            <AsideLine label="Tokens">{count(tokensOf(totals))}</AsideLine>
            <AsideLine label="Cost">
              {cost === null ? "not priced" : money(cost)}
            </AsideLine>
          </>
        )}
      </AsideSection>
      <AsideSection
        label="Providers"
        action={
          <a class="split-link" href="/config/providers">
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
