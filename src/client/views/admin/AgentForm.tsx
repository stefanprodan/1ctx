// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's form: the name, the provider it runs on, the model, found
// by typing part of its name or id into that provider's catalog, and
// the system prompt. The pick shows its window and prices when the
// catalog has them. Under the pick, thinking and effort: the default
// is the provider's, and the levels are the wire's. After the prompt,
// the skills: one line per skill on the server, the checked ones go
// with the agent into every send, at most the cap. Delete asks once
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
import { skills as skillRows } from "../../data/skills.ts";
import { limits } from "../../data/tools.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { Icon } from "../../lib/icons.tsx";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  agentFieldOf,
  type Choice,
  compactLine,
  effortApplies,
  effortChoices,
  modelMeta,
  nameProblem,
  reserveOf,
  sameIds,
  sentEffort,
  thinkingChoices,
} from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import { SkillPicker } from "./SkillPicker.tsx";
import "./agents.css";
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
  const pickedSkills = useSignal<string[]>(agent?.skills ?? []);
  // a skill deleted since the agent was saved is not a box, and it goes
  // from the save too, since the server would refuse the id; when the
  // list did not load, the ids are kept as they are
  const chosenSkills = () => {
    const rows = skillRows.value;
    return rows === null
      ? pickedSkills.value
      : pickedSkills.value.filter((id) => rows.some((s) => s.id === id));
  };
  const asking = useSignal(false);
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
      skills: chosenSkills(),
      // Preserve hidden MCP choices so an ordinary edit cannot clear them;
      // a new agent has no server and lets the token threshold choose.
      servers: agent?.servers ?? [],
      mcpMode: agent?.mcpMode ?? "auto",
    };
    if (agent) await updateAgent(agent.id, body);
    else await createAgent(body);
    onDone();
  }, agentFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
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
    effortSent !== agent.effort ||
    !sameIds(pickedSkills.value, agent.skills);
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value)) ??
        at(
          "provider",
          providerId.value === "" ? "Add a provider first" : null,
        ) ??
        at("model", model.value === null ? "Pick a model" : null),
    );
  };
  const remove = () => save.act("delete", () => deleteAgent(agent!.id));
  const picked = model.value;
  const busy = save.busy;
  const chosen = chosenSkills();
  const toggleSkill = (id: string) => {
    pickedSkills.value = chosen.includes(id)
      ? chosen.filter((s) => s !== id)
      : [...chosen, id];
    save.touch();
  };
  const compacts =
    picked === null
      ? ""
      : compactLine(picked.contextLength, reserveOf(limits.value));
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
      <div class="agents-fields">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="coder"
            aria-invalid={invalid("name") || undefined}
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
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
          <span class="label label-required">Provider</span>
          <div class="agents-picks">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                name="provider"
                aria-pressed={providerId.value === p.id}
                disabled={busy}
                class={`agents-pick${providerId.value === p.id ? " agents-pick-on" : ""}`}
                onClick={() => chooseProvider(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <FieldError save={save} field="provider" />
        </div>
        <div class="field agents-field-wide">
          <span class="label label-required">Model</span>
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
                aria-invalid={invalid("model") || undefined}
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
          <FieldError save={save} field="model" />
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
            aria-invalid={invalid("prompt") || undefined}
            disabled={busy}
            placeholder="What the agent is and how it works. Empty runs the model as it comes."
            value={prompt.value}
            onInput={(e) => {
              prompt.value = (e.currentTarget as HTMLTextAreaElement).value;
              save.touch();
            }}
          />
          <FieldError save={save} field="prompt" />
        </label>
        <SkillPicker
          available={skillRows.value}
          chosen={chosen}
          busy={busy}
          onToggle={toggleSkill}
        />
      </div>
      <Foot
        save={save}
        dirty={dirty}
        label={agent ? "Save" : "Add agent"}
        start={
          agent === null ? (
            <span />
          ) : asking.value ? (
            <>
              <span class="agents-ask-words">Delete {agent.name}?</span>
              <button
                type="button"
                class="btn btn-danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                {save.pending.value === "delete" ? "Deleting" : "Delete"}
              </button>
              <button
                type="button"
                class="btn"
                disabled={busy}
                onClick={() => {
                  asking.value = false;
                  save.touch();
                }}
              >
                Keep
              </button>
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
