// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents: a card of rows, each the name, the model and, faint, the
// provider with the model's window and prices. A row opens in place
// into its form; New agent opens an empty one at the top. Under it the
// card of providers the agents run on: added through New provider,
// deleted in place, never edited. The forms are AgentForm.tsx and
// ProviderForm.tsx.

import { useSignal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import type { Wire } from "../../../shared/words.ts";
import { AgentRow as Head } from "../../agents/AgentRow.tsx";
import { agents, agentsError } from "../../data/agents.ts";
import {
  deleteProvider,
  providers,
  providersError,
} from "../../data/providers.ts";
import { Icon } from "../../lib/icons.tsx";
import { WireMark } from "../../lib/marks.tsx";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsLine,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AgentForm } from "./AgentForm.tsx";
import { keyLine } from "./Agents.model.ts";
import { ProviderForm } from "./ProviderForm.tsx";
import "./agents.css";
import { reason } from "../../lib/format.ts";

// a provider shows its service's mark, or a cloud for a server
// without one; an agent's tile is the shared row's
function Tile({ wire }: { wire: Wire }) {
  return (
    <RowsAvatar>
      {wire === "openrouter" ? (
        <WireMark wire={wire} size={15} />
      ) : (
        <Icon name="providers" size={15} />
      )}
    </RowsAvatar>
  );
}

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

// a provider row: what it is and Delete, asked once in place
function ProviderRow({ provider }: { provider: ProviderSummary }) {
  const asking = useSignal(false);
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  const remove = async () => {
    busy.value = true;
    failure.value = null;
    try {
      await deleteProvider(provider.id);
    } catch (err) {
      failure.value = reason(err);
      busy.value = false;
    }
  };
  const keyMissing = provider.keyName !== null && !provider.hasKey;
  return (
    <RowsLine>
      <Tile wire={provider.wire} />
      <span class="agents-name">{provider.name}</span>
      <span class="agents-desc">{provider.baseUrl}</span>
      <RowsMeta bad={keyMissing}>
        {provider.wire} · {keyLine(provider.keyName, provider.hasKey)}
      </RowsMeta>
      {asking.value ? (
        <span class="agents-ask">
          {failure.value ? (
            <span class="agents-note error">{failure.value}</span>
          ) : (
            <span class="agents-ask-words">Delete {provider.name}?</span>
          )}
          <button
            type="button"
            class="btn btn-small btn-danger"
            disabled={busy.value}
            onClick={() => void remove()}
          >
            {busy.value ? "Deleting" : "Delete"}
          </button>
          <button
            type="button"
            class="btn btn-small"
            disabled={busy.value}
            onClick={() => {
              asking.value = false;
              failure.value = null;
            }}
          >
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          class="btn btn-small"
          onClick={() => {
            asking.value = true;
          }}
        >
          Delete
        </button>
      )}
    </RowsLine>
  );
}

export function Agents() {
  const list = agents.value;
  const rows = providers.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const addingProvider = useSignal(false);
  const error = agentsError.value ?? providersError.value;
  const q = useSignal("");
  const shown = (list ?? []).filter((a) =>
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
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <Rows>
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
                ? "No agents yet. Add a provider below, then make the first agent on one of its models."
                : "No agents yet. New agent picks a model from a provider below."}
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
        <RowsCard
          label="Providers"
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
          {(rows ?? []).map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </RowsCard>
      </Rows>
    </Page>
  );
}
