// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Providers: a list of links, one row per provider in name
// order, each its service's mark, the name over the base URL, and how
// many agents run on it over its type at the right; a key file that is
// missing is said under the address. The card's head searches and
// counts, New provider is in the page's head. The aside has the
// instance's last 30 days and the key files, each with the provider
// that reads it. `?new` is the New provider page.

import { useSignal } from "@preact/signals";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import type { Wire } from "../../../shared/words.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { overview, overviewError } from "../../data/overview.ts";
import { keys, providers, providersError } from "../../data/providers.ts";
import { count, pluralCommas } from "../../lib/format.ts";
import { configProviderHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { hasMark, WireMark } from "../../lib/marks.tsx";
import { byName, matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
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
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { keyLine, preset } from "./Agents.model.ts";
import { NewProvider } from "./NewProvider.tsx";
import { costOf, money, tokensOf } from "./Overview.model.ts";
import "./provider-list.css";

export function Providers() {
  if (new URLSearchParams(query.value).has("new")) return <NewProvider />;
  return <List />;
}

// a provider shows its service's mark, or a cloud for a server
// without one
export function ProviderMark({ wire }: { wire: Wire }) {
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
  const q = useSignal("");
  const all = byName(rows ?? []);
  const shown = all.filter((p) =>
    matches(q.value, [p.name, p.baseUrl, preset(p.wire).label]),
  );
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Providers"
      split
      actions={
        <a class="btn btn-small" href="/admin/config/providers?new">
          <Icon name="plus" size={14} />
          New provider
        </a>
      }
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Split aside={<Aside providers={all} />}>
        <Rows>
          <RowsCard
            label="Providers"
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search providers"
              />
            }
            count={
              all.length === 0
                ? undefined
                : shown.length !== all.length
                  ? `${shown.length} of ${all.length}`
                  : String(all.length)
            }
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
      <RowsMeta keep>
        <span class="provider-list-meta">
          <span>
            {onIt === 0 ? "No agents" : pluralCommas(onIt, "agent", "agents")}
          </span>
          <span class="provider-list-type">{preset(provider.wire).label}</span>
        </span>
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ providers: all }: { providers: ProviderSummary[] }) {
  // the aside's last 30 days, never the Monitor's other ranges
  const answer = overview.value;
  const totals = answer?.range === "30d" ? answer.totals : null;
  const cost = totals === null ? null : costOf(totals);
  // the key files by name, each with the provider that reads it
  const files = [...keys.value].sort((a, b) => a.localeCompare(b));
  return (
    <>
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
      <AsideSection label="Key files">
        {files.length === 0 ? (
          <p class="split-empty">None in the secrets directory.</p>
        ) : (
          files.map((file) => {
            const user = all.find((p) => p.keyName === file);
            return (
              <AsideLine
                key={file}
                label={`${file}.key`}
                cut
                href={user ? configProviderHref(user.name) : undefined}
                quiet={user === undefined}
              >
                {user?.name ?? "unused"}
              </AsideLine>
            );
          })
        )}
      </AsideSection>
    </>
  );
}
