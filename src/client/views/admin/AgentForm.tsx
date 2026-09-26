// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's form: the avatar, the name, the provider it runs on, the
// model, found by typing part of its name or id into that provider's
// catalog, and the system prompt. The pick shows its window and prices
// when the catalog has them; a catalog that lists only ids leaves the
// window and the tools flag to the admin, asked under the pick. On
// OpenRouter, the provider tried first. Then thinking and effort: the
// default is the provider's, and the levels are the wire's. After the
// prompt, the skills: one line per skill on the server, the checked
// ones go with the agent into every send, at most the cap; then the MCP
// servers with their read and write sides and the mode, and whether it
// is the default. Delete asks once in place.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AgentServer } from "../../../shared/contracts/mcp.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../shared/contracts/provider.ts";
import { fixedThinking } from "../../../shared/thinking.ts";
import {
  AVATARS,
  type Avatar,
  type Effort,
  type McpMode,
} from "../../../shared/words.ts";
import { modelMeta } from "../../agents/meta.ts";
import { createAgent, deleteAgent, updateAgent } from "../../data/agents.ts";
import {
  loadMcp,
  loadedAt as mcpLoadedAt,
  servers as serverRows,
} from "../../data/mcp.ts";
import { searchCatalog } from "../../data/providers.ts";
import { skills as skillRows } from "../../data/skills.ts";
import { limits } from "../../data/tools.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { Icon } from "../../lib/icons.tsx";
import { sameIds, toggledId } from "../../lib/ids.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsBad,
  RowsButton,
  RowsEnd,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  agentFieldOf,
  compactLine,
  effortApplies,
  listed,
  reserveOf,
  sameServers,
  sentEffort,
  statedFields,
  statedModel,
  statedProblem,
  thinkingChoices,
  toggleSide,
} from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import { DefaultField } from "./DefaultField.tsx";
import { EffortField } from "./EffortField.tsx";
import { McpPicker } from "./McpPicker.tsx";
import { ModelFacts } from "./ModelFacts.tsx";
import { Picks } from "./Picks.tsx";
import { SkillPicker } from "./SkillPicker.tsx";
import { UpstreamField } from "./UpstreamField.tsx";
import "./agents.css";

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
  const pickedServers = useSignal<AgentServer[]>(agent?.servers ?? []);
  const mcpMode = useSignal<McpMode>(agent?.mcpMode ?? "auto");
  const upstream = useSignal<string | null>(agent?.upstream ?? null);
  const isDefault = useSignal(agent?.default ?? false);
  // the model the upstream was chosen for: a tag names a provider of it
  const upstreamOf = useRef(agent?.model.id ?? null);
  // the window and tools an admin states when the catalog is silent
  const windowText = useSignal(agent?.model.contextLength?.toString() ?? "");
  const takesTools = useSignal(agent?.model.tools ?? false);
  // the servers are read again on open, since a background refresh
  // may have changed the rows the preview is built from
  useEffect(() => void loadMcp(), []);
  const chosenServers = () =>
    listed(pickedServers.value, (s) => s.serverId, serverRows.value);
  const chosenSkills = () =>
    listed(pickedSkills.value, (id) => id, skillRows.value);
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
      servers: chosenServers(),
      mcpMode: mcpMode.value,
      upstream:
        wireOf(providerId.value) === "openrouter" ? upstream.value : null,
      ...statedFields(model.value, windowText.value, takesTools.value),
      // sent only when flipped, so a save never moves a mark set since
      ...(isDefault.value !== (agent?.default ?? false)
        ? { default: isDefault.value }
        : {}),
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
    if (m.id !== upstreamOf.current) upstream.value = null;
    upstreamOf.current = m.id;
    // a model that always or never thinks has one choice, the default
    if (fixedThinking(m) !== null) thinking.value = null;
    windowText.value = "";
    takesTools.value = false;
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
    upstream.value = null;
    s.clear();
    save.touch();
  };
  // the pick as a send sees it, with what the admin stated
  const picked = statedModel(model.value, windowText.value, takesTools.value);
  const dirty =
    agent === null ||
    name.value.trim() !== agent.name ||
    avatar.value !== agent.avatar ||
    providerId.value !== agent.providerId ||
    model.value?.id !== agent.model.id ||
    // a pick of the same model whose catalog now says more about its
    // thinking saves it
    model.value?.thinkingRequired !== agent.model.thinkingRequired ||
    model.value?.reasoningKnown !== agent.model.reasoningKnown ||
    model.value?.reasoning !== agent.model.reasoning ||
    prompt.value.trim() !== agent.prompt ||
    thinking.value !== agent.thinking ||
    effortSent !== agent.effort ||
    !sameIds(pickedSkills.value, agent.skills) ||
    mcpMode.value !== agent.mcpMode ||
    upstream.value !== agent.upstream ||
    !sameServers(pickedServers.value, agent.servers) ||
    isDefault.value !== agent.default ||
    picked?.contextLength !== agent.model.contextLength ||
    picked?.tools !== agent.model.tools;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value)) ??
        at(
          "provider",
          providerId.value === "" ? "Add a provider first" : null,
        ) ??
        at("model", model.value === null ? "Pick a model" : null) ??
        at(
          "contextLength",
          statedProblem(model.value, windowText.value, takesTools.value),
        ),
    );
  };
  const remove = () => save.act("delete", () => deleteAgent(agent!.id));
  const busy = save.busy;
  const chosen = chosenSkills();
  const toggleServer = (serverId: string, side: "read" | "write") => {
    pickedServers.value = toggleSide(chosenServers(), serverId, side);
    save.touch();
  };
  const toggleSkill = (id: string) => {
    pickedSkills.value = toggledId(chosen, id);
    save.touch();
  };
  const compacts =
    picked === null
      ? ""
      : compactLine(picked.contextLength, reserveOf(limits.value));
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
      <div class="pair">
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
                class={`avatar avatar-32${avatar.value === a ? " agents-avatar-on" : ""}`}
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
          <Picks
            name="provider"
            choices={providers.map((p) => ({ value: p.id, label: p.name }))}
            value={providerId.value}
            busy={busy}
            onPick={chooseProvider}
          />
          <FieldError save={save} field="provider" />
        </div>
        <div class="field pair-wide">
          <span class="label label-required">Model</span>
          {picked ? (
            <RowsList>
              <RowsLine flush>
                <RowsTitle
                  name={picked.id}
                  sub={compacts === "" ? undefined : compacts}
                  mono
                />
                <RowsMeta>{modelMeta(picked)}</RowsMeta>
                <RowsEnd>
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
                </RowsEnd>
              </RowsLine>
            </RowsList>
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
            <RowsList>
              {s.error.value ? (
                <RowsNote>
                  <RowsBad>{s.error.value}</RowsBad>
                </RowsNote>
              ) : s.busy.value ? (
                <RowsNote>Searching</RowsNote>
              ) : s.matches.value.length === 0 ? (
                <RowsNote>Nothing in the catalog matches.</RowsNote>
              ) : (
                s.matches.value.map((m) => (
                  <RowsButton key={m.id} onClick={() => pick(m)}>
                    <RowsTitle name={m.name} sub={m.id} />
                    <RowsMeta>{modelMeta(m)}</RowsMeta>
                  </RowsButton>
                ))
              )}
            </RowsList>
          )}
          <FieldError save={save} field="model" />
        </div>
        {picked && !picked.described && (
          <ModelFacts
            save={save}
            window={windowText.value}
            tools={takesTools.value}
            busy={busy}
            onWindow={(value) => {
              windowText.value = value;
              save.touch();
            }}
            onTools={(value) => {
              takesTools.value = value;
              save.touch();
            }}
          />
        )}
        {picked && wire === "openrouter" && (
          <UpstreamField
            providerId={providerId.value}
            model={picked}
            value={upstream.value}
            busy={busy}
            save={save}
            onChange={(value) => {
              upstream.value = value;
              save.touch();
            }}
          />
        )}
        {picked && (
          <div class="field">
            <span class="label">Thinking</span>
            <Picks
              choices={thinkingChoices(picked)}
              value={fixedThinking(picked) === null ? thinking.value : null}
              busy={busy}
              onPick={(value) => {
                thinking.value = value;
                save.touch();
              }}
            />
          </div>
        )}
        {picked && effortShown && wire !== undefined && (
          <EffortField
            wire={wire}
            value={effort.value}
            busy={busy}
            onChange={(value) => {
              effort.value = value;
              save.touch();
            }}
          />
        )}
        <label class="field pair-wide">
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
        <DefaultField agent={agent} on={isDefault} save={save} />
        <SkillPicker
          available={skillRows.value}
          chosen={chosen}
          busy={busy}
          onToggle={toggleSkill}
        />
        <McpPicker
          available={serverRows.value}
          loadedAt={mcpLoadedAt.value}
          chosen={chosenServers()}
          mode={mcpMode.value}
          takesTools={picked?.tools ?? true}
          busy={busy}
          onToggle={toggleServer}
          onMode={(mode) => {
            mcpMode.value = mode;
            save.touch();
          }}
        />
      </div>
      <Foot
        save={save}
        dirty={dirty}
        label={agent ? "Save" : "Add agent"}
        start={
          agent === null ? (
            <span />
          ) : (
            <AskDelete
              save={save}
              asking={asking}
              busy={busy}
              words={`Delete ${agent.name}?`}
              wordsClass="agents-ask-words"
              onDelete={() => void remove()}
            />
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
