// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's form: the name, the provider it runs on, the model, found
// by typing part of its name or id into that provider's catalog, and
// the system prompt. The pick shows its window and prices when the
// catalog has them. Under the pick, thinking and effort: the default
// is the provider's, and the levels are the wire's. Delete asks once
// in place.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../shared/contracts/provider.ts";
import { AVATARS, type Avatar, type Effort } from "../../../shared/words.ts";
import { createAgent, deleteAgent, updateAgent } from "../../data/agents.ts";
import { searchCatalog } from "../../data/providers.ts";
import { limits } from "../../data/tools.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { Icon } from "../../lib/icons.tsx";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import {
  type Choice,
  compactLine,
  effortApplies,
  effortChoices,
  modelMeta,
  nameProblem,
  reserveOf,
  sentEffort,
  thinkingChoices,
} from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import "./agents.css";
import { reason } from "../../lib/format.ts";
import { shapedInput } from "../../lib/names.ts";

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

// one row of chips, the chosen one lit, as the provider picker
function Picks<T extends string | null>({
  choices,
  value,
  busy,
  onPick,
}: {
  choices: Choice<T>[];
  value: T;
  busy: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div class="agents-picks">
      {choices.map((choice) => (
        <button
          key={choice.value ?? "default"}
          type="button"
          aria-pressed={value === choice.value}
          disabled={busy}
          class={`agents-pick${
            value === choice.value ? " agents-pick-on" : ""
          }`}
          onClick={() => onPick(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
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
  const prompt = useSignal(agent?.prompt ?? "");
  const thinking = useSignal<"on" | "off" | null>(agent?.thinking ?? null);
  const effort = useSignal<Effort | null>(agent?.effort ?? null);
  const avatar = useSignal<Avatar>(agent?.avatar ?? "bot");
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
  // the save call is made once, with the form, so it reads the signals
  // and the latest providers when it runs, never a render's copy
  const latest = useRef(providers);
  latest.current = providers;
  const wireOf = (id: string) => latest.current.find((p) => p.id === id)?.wire;
  const wire = wireOf(providerId.value);
  const effortShown =
    wire !== undefined && effortApplies(model.value, thinking.value);
  const effortSent = sentEffort(
    model.value,
    thinking.value,
    effort.value,
    wire,
  );
  const save = useSave(async () => {
    const body = {
      name: name.value.trim(),
      avatar: avatar.value,
      providerId: providerId.value,
      model: model.value?.id ?? "",
      prompt: prompt.value.trim(),
      thinking: thinking.value,
      effort: sentEffort(
        model.value,
        thinking.value,
        effort.value,
        wireOf(providerId.value),
      ),
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
  // another provider means another catalog and another set of levels:
  // the pick and the effort go with it
  const chooseProvider = (id: string) => {
    if (id === providerId.value) return;
    providerId.value = id;
    model.value = null;
    effort.value = null;
    s.clear();
    save.touch();
  };
  const dirty =
    agent === null ||
    name.value.trim() !== agent.name ||
    avatar.value !== agent.avatar ||
    providerId.value !== agent.providerId ||
    model.value?.id !== agent.model.id ||
    prompt.value.trim() !== agent.prompt ||
    thinking.value !== agent.thinking ||
    effortSent !== agent.effort;
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
  const compacts =
    picked === null
      ? ""
      : compactLine(picked.contextLength, reserveOf(limits.value));
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
              name.value = shapedInput(e);
              save.touch();
            }}
          />
        </label>
        <div class="field">
          <span class="label">Avatar</span>
          <div class="agents-avatars">
            {AVATARS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={avatar.value === a}
                aria-label={a}
                disabled={busy}
                class={`agents-avatar${avatar.value === a ? " agents-avatar-on" : ""}`}
                onClick={() => {
                  avatar.value = a;
                  save.touch();
                }}
              >
                <AvatarIcon name={a} size={16} />
              </button>
            ))}
          </div>
        </div>
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
              <span class="agents-model">
                <span class="agents-model-picked">{picked.id}</span>
                {compacts !== "" && (
                  <span class="agents-model-id">{compacts}</span>
                )}
              </span>
              <span class="agents-model-meta">{modelMeta(picked)}</span>
              <button
                type="button"
                class="btn btn-small"
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
        {picked && (
          <div class="field">
            <span class="label">Thinking</span>
            <Picks
              choices={thinkingChoices(picked)}
              value={thinking.value}
              busy={busy}
              onPick={(value) => {
                thinking.value = value;
                save.touch();
              }}
            />
          </div>
        )}
        {picked && effortShown && wire !== undefined && (
          <label class="field">
            <span class="label">Effort</span>
            <span class="agents-select">
              <select
                name="effort"
                class="agents-select-input"
                disabled={busy}
                onChange={(e) => {
                  const value = (e.currentTarget as HTMLSelectElement).value;
                  effort.value = value === "" ? null : (value as Effort);
                  save.touch();
                }}
              >
                {effortChoices(wire).map((choice) => (
                  // Preact sets no default on a select, so the option
                  // carries the selection
                  <option
                    key={choice.value ?? ""}
                    value={choice.value ?? ""}
                    selected={effort.value === choice.value}
                  >
                    {choice.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={14} class="agents-select-chevron" />
            </span>
          </label>
        )}
        <label class="field agents-field-wide">
          <span class="label">System prompt</span>
          <textarea
            name="prompt"
            class="agents-prompt"
            rows={5}
            spellcheck={false}
            disabled={busy}
            placeholder="What the agent is and how it works. Empty runs the model as it comes."
            value={prompt.value}
            onInput={(e) => {
              prompt.value = (e.currentTarget as HTMLTextAreaElement).value;
              save.touch();
            }}
          />
        </label>
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
                class="btn btn-danger"
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
