// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import { decisions, decisionsError } from "../../data/decisions.ts";
import { providers, providersError } from "../../data/providers.ts";
import { configDeciderHref, configDecisionHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { byName, useListSearch } from "../../lib/search.ts";
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
import { Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { overviewTotals, SpendLines, UsageSection } from "./AdminAside.tsx";
import {
  deciderMeta,
  deciderProviders,
  NO_DECIDERS,
} from "./Deciders.model.ts";
import { byTitle, DECISION_WORDS, decisionMeta } from "./Decisions.model.ts";
import { NewDecider } from "./NewDecider.tsx";
import "./decider-list.css";

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
  return (
    <UsageSection value={overviewTotals()}>
      {(totals) => (
        <SpendLines
          label="Answers"
          count={totals.decisions}
          tokens={totals.decisionTokens}
          cost={totals.decisionCost}
        />
      )}
    </UsageSection>
  );
}

export function DeciderList() {
  if (new URLSearchParams(query.value).has("new")) return <NewDecider />;
  return <Deciders />;
}

function Deciders() {
  const list = deciders.value;
  const rows = providers.value;
  const providerName = (d: DeciderSummary) =>
    rows?.find((p) => p.id === d.providerId)?.name ?? "";
  const all = byName(list ?? []);
  const { q, shown, count } = useListSearch(all, (d) => [
    d.name,
    d.model,
    providerName(d),
  ]);
  const canAdd = deciderProviders(rows ?? []).length > 0;
  const error = decidersError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Deciders"
      split
      actions={
        canAdd && (
          <PageNew href="/admin/config/deciders?new" label="New decider" />
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
              search={<Search query={q} placeholder="Search deciders" />}
              count={count}
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
                  <RowsMeta keep under={deciderMeta(d)}>
                    <span class="decider-list-provider cut">
                      {providerName(d)}
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
  const all = byTitle(list ?? []);
  const { q, shown, count } = useListSearch(all, (d) => [
    DECISION_WORDS[d.id].title,
    DECISION_WORDS[d.id].sub,
    d.id,
    known.find((x) => x.id === d.deciderId)?.name,
  ]);
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
              search={<Search query={q} placeholder="Search decisions" />}
              count={count}
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
