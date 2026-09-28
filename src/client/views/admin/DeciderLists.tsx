// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Deciders and its Decisions tab, one list each at an address
// of its own, both under the tabs Deciders and Decisions. A decider row
// is its name and "default" over the model, its provider over the
// window and the price at the right; a decision row its title over what
// it reads, on or off and who answers at the right. Every row opens its
// page. The aside has the instance's decisions over the last 30 days.
// `?new` on the deciders is the New decider page.

import { useSignal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import { decisions, decisionsError } from "../../data/decisions.ts";
import { overview, overviewError } from "../../data/overview.ts";
import { providers, providersError } from "../../data/providers.ts";
import { count } from "../../lib/format.ts";
import { configDeciderHref, configDecisionHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { byName, matches } from "../../lib/search.ts";
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
import { Tabs } from "../../ui/Tabs.tsx";
import {
  deciderMeta,
  deciderProviders,
  NO_DECIDERS,
} from "./Deciders.model.ts";
import { DECISION_WORDS, decisionMeta } from "./Decisions.model.ts";
import { NewDecider } from "./NewDecider.tsx";
import { money } from "./Overview.model.ts";
import "./decider-list.css";

// both lists' tabs, each counting its rows
function ListTabs({ on }: { on: "deciders" | "decisions" }) {
  return (
    <Tabs
      tabs={[
        {
          label: "Deciders",
          href: "/admin/config/deciders",
          count: deciders.value?.length,
        },
        {
          label: "Decisions",
          href: "/admin/config/decisions",
          count: decisions.value?.length,
        },
      ]}
      active={
        on === "deciders" ? "/admin/config/deciders" : "/admin/config/decisions"
      }
    />
  );
}

function Aside() {
  // the aside's last 30 days, never the Monitor's other ranges
  const answer = overview.value;
  const totals = answer?.range === "30d" ? answer.totals : null;
  return (
    <AsideSection
      label="Last 30 days"
      action={
        <a class="split-link" href="/admin/monitor">
          Usage
        </a>
      }
    >
      {totals === null ? (
        <p class="split-empty">
          {overviewError.value === null ? "Loading" : "Did not load."}
        </p>
      ) : (
        <>
          <AsideLine label="Answers">{count(totals.decisions)}</AsideLine>
          <AsideLine label="Tokens">{count(totals.decisionTokens)}</AsideLine>
          <AsideLine label="Cost">
            {totals.decisionCost === null
              ? "not priced"
              : money(totals.decisionCost)}
          </AsideLine>
        </>
      )}
    </AsideSection>
  );
}

// "3 of 5" while a search narrows the list
const countOf = (shown: number, all: number) =>
  all === 0 ? undefined : shown === all ? String(all) : `${shown} of ${all}`;

export function DeciderList() {
  if (new URLSearchParams(query.value).has("new")) return <NewDecider />;
  return <Deciders />;
}

function Deciders() {
  const list = deciders.value;
  const rows = providers.value;
  const q = useSignal("");
  const providerName = (d: DeciderSummary) =>
    rows?.find((p) => p.id === d.providerId)?.name ?? "";
  const all = byName(list ?? []);
  const shown = all.filter((d) =>
    matches(q.value, [d.name, d.model, providerName(d)]),
  );
  // a decider runs only on a provider whose wire answers decisions
  const canAdd = deciderProviders(rows ?? []).length > 0;
  const error = decidersError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Deciders"
      split
      actions={
        canAdd && (
          <a class="btn btn-small" href="/admin/config/deciders?new">
            <Icon name="plus" size={14} />
            New decider
          </a>
        )
      }
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Split aside={<Aside />}>
        <div class="decider-list">
          <ListTabs on="deciders" />
          <Rows>
            <RowsCard
              label="Deciders"
              wrap
              search={
                <Search
                  value={q.value}
                  onChange={(next) => {
                    q.value = next;
                  }}
                  placeholder="Search deciders"
                />
              }
              count={countOf(shown.length, all.length)}
            >
              {all.length === 0 && (
                <RowsNote>
                  {canAdd
                    ? NO_DECIDERS
                    : "No deciders yet. Add an OpenRouter or OpenAI-compatible provider first, then a decider on one of its models."}
                </RowsNote>
              )}
              {all.length > 0 && shown.length === 0 && (
                <RowsNote>No decider matches.</RowsNote>
              )}
              {shown.map((d) => (
                <RowsGo key={d.id} href={configDeciderHref(d.name)}>
                  <RowsAvatar>
                    <Icon name="check" size={15} />
                  </RowsAvatar>
                  <RowsTitle
                    mono
                    name={
                      <>
                        <span class="cut">{d.name}</span>
                        {d.default && <RowsTag>default</RowsTag>}
                      </>
                    }
                    sub={d.model}
                  />
                  <RowsMeta keep>
                    <span class="decider-list-meta">
                      <span class="decider-list-provider cut">
                        {providerName(d)}
                      </span>
                      <span class="decider-list-facts">{deciderMeta(d)}</span>
                    </span>
                  </RowsMeta>
                </RowsGo>
              ))}
            </RowsCard>
          </Rows>
        </div>
      </Split>
    </Page>
  );
}

export function DecisionList() {
  const list = decisions.value;
  const known = deciders.value ?? [];
  const q = useSignal("");
  const all = [...(list ?? [])].sort((a, b) =>
    DECISION_WORDS[a.id].title.localeCompare(DECISION_WORDS[b.id].title),
  );
  const shown = all.filter((d) => {
    const words = DECISION_WORDS[d.id];
    const by = known.find((x) => x.id === d.deciderId)?.name ?? "";
    return matches(q.value, [words.title, words.sub, d.id, by]);
  });
  const error = decisionsError.value ?? decidersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Decisions"
      split
      loading={(list === null || deciders.value === null) && error === null}
      error={error}
    >
      <Split aside={<Aside />}>
        <div class="decider-list">
          <ListTabs on="decisions" />
          <Rows>
            <RowsCard
              label="Decisions"
              search={
                <Search
                  value={q.value}
                  onChange={(next) => {
                    q.value = next;
                  }}
                  placeholder="Search decisions"
                />
              }
              count={countOf(shown.length, all.length)}
            >
              {all.length > 0 && shown.length === 0 && (
                <RowsNote>No decision matches.</RowsNote>
              )}
              {shown.map((d) => {
                const words = DECISION_WORDS[d.id];
                const meta = decisionMeta(d, known);
                return (
                  <RowsGo
                    key={d.id}
                    href={configDecisionHref(d.id)}
                    off={!d.enabled || known.length === 0}
                  >
                    <RowsAvatar>
                      <Icon name={words.icon} size={15} />
                    </RowsAvatar>
                    <RowsTitle name={words.title} sub={words.sub} />
                    <RowsMeta short={meta.short}>{meta.long}</RowsMeta>
                  </RowsGo>
                );
              })}
            </RowsCard>
          </Rows>
        </div>
      </Split>
    </Page>
  );
}
