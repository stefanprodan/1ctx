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
import { useEffect } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { agents, agentsError, loadAgents } from "../../data/agents.ts";
import {
  deleteProvider,
  loadProviders,
  providers,
  providersError,
} from "../../data/providers.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import { AgentForm } from "./AgentForm.tsx";
import { keyLine, modelMeta } from "./Agents.model.ts";
import { ProviderForm } from "./ProviderForm.tsx";
import "./agents.css";

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function Tile({ icon, lit }: { icon: IconName; lit: boolean }) {
  return (
    <span class={`agents-tile${lit ? " agents-tile-lit" : ""}`}>
      <Icon name={icon} size={15} />
    </span>
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
  const meta = [provider?.name ?? "?", modelMeta(agent.model)]
    .filter((s) => s !== "")
    .join(" · ");
  return (
    <div class={`agents-item${open ? " agents-item-open" : ""}`}>
      <button
        type="button"
        class="agents-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon
          name="chevron"
          size={14}
          class={`agents-chevron${open ? " agents-chevron-open" : ""}`}
        />
        <Tile icon="agents" lit={open} />
        <span class="agents-name">{agent.name}</span>
        <span class="agents-desc">{agent.model.name}</span>
        <span class="agents-meta">{meta}</span>
      </button>
      {open && (
        <div class="agents-body">
          <AgentForm agent={agent} providers={providers} onDone={onToggle} />
        </div>
      )}
    </div>
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
    <div class="agents-item">
      <div class="agents-provider">
        <Tile icon="providers" lit={false} />
        <span class="agents-name">{provider.name}</span>
        <span class="agents-desc agents-url">{provider.baseUrl}</span>
        <span class={`agents-meta${keyMissing ? " agents-meta-bad" : ""}`}>
          {provider.wire} · {keyLine(provider.keyName, provider.hasKey)}
        </span>
        {asking.value ? (
          <span class="agents-provider-ask">
            {failure.value ? (
              <span class="agents-note error">{failure.value}</span>
            ) : (
              <span class="agents-ask">Delete {provider.name}?</span>
            )}
            <button
              type="button"
              class="btn agents-small agents-danger"
              disabled={busy.value}
              onClick={() => void remove()}
            >
              {busy.value ? "Deleting" : "Delete"}
            </button>
            <button
              type="button"
              class="btn agents-small"
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
            class="btn agents-small"
            onClick={() => {
              asking.value = true;
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export function Agents() {
  useEffect(() => {
    if (agents.value === null) void loadAgents();
    if (providers.value === null) void loadProviders();
  }, []);
  const list = agents.value;
  const rows = providers.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const addingProvider = useSignal(false);
  const error = agentsError.value ?? providersError.value;
  return (
    <Page
      crumb="Admin"
      title="Agents"
      loading={(list === null || rows === null) && error === null}
      error={error}
    >
      <div class="agents">
        <section class="agents-card">
          <div class="agents-card-head">
            <span class="label">Agents</span>
            <button
              type="button"
              class="btn agents-small agents-card-act"
              disabled={adding.value || !rows || rows.length === 0}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            >
              <Icon name="plus" size={14} />
              New agent
            </button>
          </div>
          {adding.value && (
            <div class="agents-item agents-item-open">
              <div class="agents-body agents-body-new">
                <AgentForm
                  agent={null}
                  providers={rows ?? []}
                  onDone={() => {
                    adding.value = false;
                  }}
                />
              </div>
            </div>
          )}
          {list?.length === 0 && !adding.value && (
            <p class="agents-state">
              {rows?.length === 0
                ? "No agents yet. Add a provider below, then make the first agent on one of its models."
                : "No agents yet. New agent picks a model from a provider below."}
            </p>
          )}
          {(list ?? []).map((a) => (
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
        </section>
        <section class="agents-card">
          <div class="agents-card-head">
            <span class="label">Providers</span>
            <button
              type="button"
              class="btn agents-small agents-card-act"
              disabled={addingProvider.value}
              onClick={() => {
                addingProvider.value = true;
              }}
            >
              <Icon name="plus" size={14} />
              New provider
            </button>
          </div>
          {addingProvider.value && (
            <div class="agents-item agents-item-open">
              <div class="agents-body agents-body-new">
                <ProviderForm
                  onDone={() => {
                    addingProvider.value = false;
                  }}
                />
              </div>
            </div>
          )}
          {rows?.length === 0 && !addingProvider.value && (
            <p class="agents-state">
              No providers yet. Add one so an agent has a model to run on.
            </p>
          )}
          {(rows ?? []).map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </section>
      </div>
    </Page>
  );
}
