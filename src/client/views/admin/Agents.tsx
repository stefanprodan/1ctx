// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents page, top to bottom, each card with its search: the
// providers the agents and deciders run on, added through New provider,
// a row opening to what it is and Delete, never edited (ProviderRow.tsx);
// the agents, a card of rows, each the name, the model and, faint, the
// provider with the model's window and prices, a row opening in place
// into its form, or starting open when `?open=` names it, New agent
// opening an empty one at the top; then the deciders (DecidersCard.tsx)
// and the decisions they answer (DecisionsCard.tsx). The forms are
// AgentForm.tsx and ProviderForm.tsx.

import { useSignal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { AgentRow as Head } from "../../agents/AgentRow.tsx";
import { agents, agentsError } from "../../data/agents.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import { decisions, decisionsError } from "../../data/decisions.ts";
import { providers, providersError } from "../../data/providers.ts";
import { byName, matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsCard,
  RowsNew,
  RowsNote,
  RowsOpen,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AgentForm } from "./AgentForm.tsx";
import { DecidersCard } from "./DecidersCard.tsx";
import { DecisionsCard } from "./DecisionsCard.tsx";
import { useOpenParam } from "./OpenParam.ts";
import { ProviderForm } from "./ProviderForm.tsx";
import { ProviderRow } from "./ProviderRow.tsx";
import "./agents.css";

function AgentRow({
  agent,
  providers,
  open,
  onToggle,
}: {
  agent: AgentSummary;
  providers: ProviderSummary[];
  open: boolean;
  onToggle: () => void;
}) {
  const provider = providers.find((p) => p.id === agent.providerId);
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      head={
        <Head agent={agent} providerName={provider?.name ?? "?"} lit={open} />
      }
    >
      <AgentForm agent={agent} providers={providers} onDone={onToggle} />
    </RowsOpen>
  );
}

export function Agents() {
  const list = agents.value;
  const rows = providers.value;
  const open = useOpenParam();
  const adding = useSignal(false);
  const addingProvider = useSignal(false);
  const openProvider = useSignal<string | null>(null);
  const pq = useSignal("");
  const shownProviders = byName(rows ?? []).filter((p) =>
    matches(pq.value, [p.name, p.baseUrl, p.wire, p.keyName ?? ""]),
  );
  const error = agentsError.value ?? providersError.value;
  const q = useSignal("");
  const shown = byName(list ?? []).filter((a) =>
    matches(q.value, [
      a.name,
      a.model.id,
      rows?.find((p) => p.id === a.providerId)?.name ?? "",
    ]),
  );
  return (
    <Page
      crumb="Admin"
      title="Agents"
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
        <RowsCard
          label="Agents"
          search={
            <Search
              value={q.value}
              onChange={(next) => {
                q.value = next;
              }}
              placeholder="Search agents"
            />
          }
          action={
            <RowsAdd
              label="New agent"
              disabled={adding.value || !rows || rows.length === 0}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            />
          }
        >
          {adding.value && (
            <RowsNew>
              <AgentForm
                agent={null}
                providers={rows ?? []}
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {list?.length === 0 && !adding.value && (
            <RowsNote>
              {rows?.length === 0
                ? "No agents yet. Add a provider above, then make the first agent on one of its models."
                : "No agents yet. New agent picks a model from a provider above."}
            </RowsNote>
          )}
          {q.value.trim() !== "" && shown.length === 0 && (
            <RowsNote>No agents found</RowsNote>
          )}
          {shown.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              providers={rows ?? []}
              open={open.value === a.id}
              onToggle={() => {
                open.value = open.value === a.id ? null : a.id;
                adding.value = false;
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
