// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's form: the name, the provider it runs on, and the model,
// found by typing part of its name or id into that provider's catalog.
// The pick shows its window and prices when the catalog has them.
// Delete asks once in place.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../shared/contracts/provider.ts";
import { createAgent, deleteAgent, updateAgent } from "../../data/agents.ts";
import { searchCatalog } from "../../data/providers.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { modelMeta, nameProblem } from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import "./agents.css";

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// one catalog line: the name over the id, the rest faint at the right
function Line({ model }: { model: CatalogMatch }) {
  return (
    <>
      <span class="agents-model">
        <span class="agents-model-name">{model.name}</span>
        <span class="agents-model-id">{model.id}</span>
      </span>
      <span class="agents-model-meta">{modelMeta(model)}</span>
    </>
  );
}

export function AgentForm({
  agent,
  providers,
  onDone,
}: {
  agent: AgentSummary | null;
  providers: ProviderSummary[];
  onDone: () => void;
}) {
  const name = useSignal(agent?.name ?? "");
  const providerId = useSignal(agent?.providerId ?? providers[0]?.id ?? "");
  const model = useSignal<CatalogMatch | null>(agent?.model ?? null);
  const asking = useSignal(false);
  const failure = useSignal<string | null>(null);
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(providerId.value, q),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const s = search.current;
  // the provider picked may be deleted from the same page
  useEffect(() => {
    if (
      providerId.value !== "" &&
      !providers.some((p) => p.id === providerId.value)
    ) {
      providerId.value = "";
      model.value = null;
      s.clear();
    }
  }, [providers]);
  const save = useSave(async () => {
    const body = {
      name: name.value.trim(),
      providerId: providerId.value,
      model: model.value?.id ?? "",
    };
    if (agent) await updateAgent(agent.id, body);
    else await createAgent(body);
    onDone();
  });
  const pick = (m: CatalogMatch) => {
    model.value = m;
    s.clear();
    save.touch();
  };
  // another provider means another catalog: the pick goes with it
  const chooseProvider = (id: string) => {
    if (id === providerId.value) return;
    providerId.value = id;
    model.value = null;
    s.clear();
    save.touch();
  };
  const dirty =
    agent === null ||
    name.value.trim() !== agent.name ||
    providerId.value !== agent.providerId ||
    model.value?.id !== agent.model.id;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      nameProblem(name.value) ??
        (providerId.value === "" ? "Add a provider first" : null) ??
        (model.value === null ? "Pick a model" : null),
    );
  };
  const remove = async () => {
    failure.value = null;
    try {
      await deleteAgent(agent!.id);
    } catch (err) {
      failure.value = reason(err);
    }
  };
  const picked = model.value;
  const busy = save.status.value === "busy";
  return (
    <form class="agents-form" onSubmit={submit}>
      <div class="agents-fields">
        <label class="field">
          <span class="label">Name</span>
          <input
            name="name"
            autocomplete="off"
            spellcheck={false}
            placeholder="coder"
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = (e.currentTarget as HTMLInputElement).value;
              save.touch();
            }}
          />
        </label>
        <div class="field">
          <span class="label">Provider</span>
          <div class="agents-picks">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={providerId.value === p.id}
                disabled={busy}
                class={`agents-pick${providerId.value === p.id ? " agents-pick-on" : ""}`}
                onClick={() => chooseProvider(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div class="field agents-field-wide">
          <span class="label">Model</span>
          {picked ? (
            <div class="agents-picked">
              <Line model={picked} />
              <button
                type="button"
                class="btn agents-small"
                disabled={busy}
                onClick={() => {
                  model.value = null;
                  save.touch();
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div class="agents-search">
              <Icon name="search" size={14} class="agents-search-icon" />
              <input
                type="search"
                name="model"
                class="agents-search-input"
                autocomplete="off"
                spellcheck={false}
                disabled={busy || providerId.value === ""}
                placeholder="Type part of the model's name or id"
                value={s.query.value}
                onInput={(e) =>
                  s.type((e.currentTarget as HTMLInputElement).value)
                }
              />
            </div>
          )}
          {!picked && s.query.value.trim() !== "" && (
            <div class="agents-matches">
              {s.error.value ? (
                <p class="agents-state error">{s.error.value}</p>
              ) : s.busy.value ? (
                <p class="agents-state">Searching</p>
              ) : s.matches.value.length === 0 ? (
                <p class="agents-state">Nothing in the catalog matches.</p>
              ) : (
                s.matches.value.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    class="agents-match"
                    onClick={() => pick(m)}
                  >
                    <Line model={m} />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <Foot
        status={save.status.value}
        dirty={dirty}
        label={agent ? "Save" : "Add agent"}
        start={
          agent === null ? (
            <span />
          ) : asking.value ? (
            <>
              <span class="agents-ask">Delete {agent.name}?</span>
              <button
                type="button"
                class="btn agents-danger"
                onClick={() => void remove()}
              >
                Delete
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => {
                  asking.value = false;
                  failure.value = null;
                }}
              >
                Keep
              </button>
              {failure.value && (
                <span class="agents-note error">{failure.value}</span>
              )}
            </>
          ) : (
            <button
              type="button"
              class="btn"
              onClick={() => {
                asking.value = true;
              }}
            >
              Delete
            </button>
          )
        }
        before={
          <button type="button" class="btn" onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}
