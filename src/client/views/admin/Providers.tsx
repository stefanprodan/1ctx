// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import type { Wire } from "../../../shared/words.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { keys, providers, providersError } from "../../data/providers.ts";
import { pluralCommas } from "../../lib/format.ts";
import { configProviderHref, PROVIDERS_HREF } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { hasMark, WireMark } from "../../lib/marks.tsx";
import { byName, useListSearch } from "../../lib/search.ts";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { Split } from "../../ui/Split.tsx";
import {
  KeyFilesSection,
  overviewTotals,
  SpendLines,
  UsageSection,
} from "./AdminAside.tsx";
import { NewProvider } from "./NewProvider.tsx";
import { costOf, tokensOf } from "./Overview.model.ts";
import { keyLine, preset } from "./Providers.model.ts";
import "./provider-list.css";

export function Providers() {
  if (new URLSearchParams(query.value).has("new")) return <NewProvider />;
  return <List />;
}

function ProviderMark({ wire }: { wire: Wire }) {
  return (
    <RowsAvatar>
      {hasMark(wire) ? (
        <WireMark wire={wire} size={15} />
      ) : (
        <Icon name="providers" size={15} />
      )}
    </RowsAvatar>
  );
}

function List() {
  const list = agents.value;
  const rows = providers.value;
  const all = byName(rows ?? []);
  const { q, shown, count } = useListSearch(all, (p) => [
    p.name,
    p.baseUrl,
    preset(p.wire).label,
  ]);
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Providers"
      split
      actions={<PageNew href={`${PROVIDERS_HREF}?new`} label="New provider" />}
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Split aside={<Aside providers={all} />}>
        <Rows>
          <RowsCard
            label="Providers"
            search={<Search query={q} placeholder="Search providers" />}
            count={count}
          >
            {all.length === 0 && (
              <RowsNote>
                No providers yet. Add one so an agent has a model to run on.
              </RowsNote>
            )}
            {all.length > 0 && shown.length === 0 && (
              <RowsNote>No provider matches.</RowsNote>
            )}
            {shown.map((p) => (
              <Row
                key={p.id}
                provider={p}
                agents={
                  (list ?? []).filter((a) => a.providerId === p.id).length
                }
              />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}

function Row({
  provider,
  agents: onIt,
}: {
  provider: ProviderSummary;
  agents: number;
}) {
  const missing = provider.keyName !== null && !provider.hasKey;
  return (
    <RowsGo href={configProviderHref(provider.name)}>
      <ProviderMark wire={provider.wire} />
      <RowsTitle
        mono
        name={provider.name}
        sub={
          <span class="provider-list-sub">
            <span class="cut">{provider.baseUrl}</span>
            {missing && (
              <span class="provider-list-bad">
                {keyLine(provider.keyName, false)}
              </span>
            )}
          </span>
        }
      />
      <RowsMeta keep under={preset(provider.wire).label}>
        {onIt === 0 ? "No agents" : pluralCommas(onIt, "agent", "agents")}
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ providers: all }: { providers: ProviderSummary[] }) {
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
      <KeyFilesSection
        files={keys.value}
        reader={(file) => {
          const user = all.find((p) => p.keyName === file);
          return user
            ? { label: user.name, href: configProviderHref(user.name) }
            : { label: "unused", quiet: true };
        }}
      />
    </>
  );
}
