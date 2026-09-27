// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The providers page, top to bottom, each card with its search: the
// providers the agents and deciders run on, added through New provider,
// a row opening to what it is and Delete, never edited (ProviderRow.tsx);
// then the deciders (DecidersCard.tsx) and the decisions they answer
// (DecisionsCard.tsx). The agents have their own pages under Config.

import { useSignal } from "@preact/signals";
import { agents, agentsError } from "../../data/agents.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import { decisions, decisionsError } from "../../data/decisions.ts";
import { providers, providersError } from "../../data/providers.ts";
import { byName, matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import { Rows, RowsAdd, RowsCard, RowsNew, RowsNote } from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { DecidersCard } from "./DecidersCard.tsx";
import { DecisionsCard } from "./DecisionsCard.tsx";
import { ProviderForm } from "./ProviderForm.tsx";
import { ProviderRow } from "./ProviderRow.tsx";
import "./agents.css";
import { zoneStep } from "../../app/zones.ts";

export function Providers() {
  const list = agents.value;
  const rows = providers.value;
  const addingProvider = useSignal(false);
  const openProvider = useSignal<string | null>(null);
  const pq = useSignal("");
  const shownProviders = byName(rows ?? []).filter((p) =>
    matches(pq.value, [p.name, p.baseUrl, p.wire, p.keyName ?? ""]),
  );
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Providers"
      loading={
        (list === null ||
          rows === null ||
          (deciders.value === null && decidersError.value === null) ||
          (decisions.value === null && decisionsError.value === null)) &&
        error === null
      }
      error={error}
    >
      <Rows>
        <RowsCard
          label="Providers"
          search={
            <Search
              value={pq.value}
              onChange={(next) => {
                pq.value = next;
              }}
              placeholder="Search providers"
            />
          }
          action={
            <RowsAdd
              label="New provider"
              disabled={addingProvider.value}
              onClick={() => {
                addingProvider.value = true;
              }}
            />
          }
        >
          {addingProvider.value && (
            <RowsNew>
              <ProviderForm
                onDone={() => {
                  addingProvider.value = false;
                }}
              />
            </RowsNew>
          )}
          {rows?.length === 0 && !addingProvider.value && (
            <RowsNote>
              No providers yet. Add one so an agent has a model to run on.
            </RowsNote>
          )}
          {pq.value.trim() !== "" && shownProviders.length === 0 && (
            <RowsNote>No providers found</RowsNote>
          )}
          {shownProviders.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              open={openProvider.value === p.id}
              onToggle={() => {
                openProvider.value = openProvider.value === p.id ? null : p.id;
                addingProvider.value = false;
              }}
            />
          ))}
        </RowsCard>
        <DecidersCard providers={rows ?? []} />
        <DecisionsCard />
      </Rows>
    </Page>
  );
}
