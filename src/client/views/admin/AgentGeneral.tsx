// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { navigate } from "../../app/router.ts";
import {
  agents,
  deleteAgent,
  factsFor,
  loadFacts,
  updateAgent,
} from "../../data/agents.ts";
import { AGENTS_HREF, configAgentHref } from "../../lib/hrefs.ts";
import { nameProblem, nameTaken } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { Setting, SettingDelete, SettingForm } from "../../ui/Setting.tsx";
import { AgentModel } from "./AgentModel.tsx";
import { cardBody, cardFieldOf, deleteLine } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { AgentSubagents } from "./AgentSubagents.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import { NameFields } from "./NameFields.tsx";

export function AgentGeneral({
  agent,
  drafts,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  return (
    <>
      <Identity agent={agent} drafts={drafts} />
      <AgentModel agent={agent} drafts={drafts} />
      <AgentSubagents agent={agent} drafts={drafts} />
      <SettingDelete
        title={`Delete @${agent.name}`}
        line={deleteLine(factsFor(agent.id)?.impact ?? null)}
        ask={`Delete @${agent.name}?`}
        lock={drafts.saving}
        onAsk={() => loadFacts(agent.name)}
        onDelete={() => deleteAgent(agent.id)}
        leaveTo={AGENTS_HREF}
      />
    </>
  );
}

function Identity({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  const save = useSave(
    () =>
      d.save(async () => {
        const was = latest.current;
        const saved = await updateAgent(
          was.id,
          cardBody(
            was,
            {
              name: d.name.value.trim(),
              avatar: d.avatar.value,
              prompt: d.prompt.value.trim(),
              // sent only when flipped, so a save never moves a mark
              // set since
              ...(d.isDefault.value !== was.default
                ? { default: d.isDefault.value }
                : {}),
            },
            loadedRows(),
          ),
        );
        d.resetGeneral(saved);
        if (saved.name !== was.name) {
          navigate(configAgentHref(saved.name), true);
        }
      }),
    cardFieldOf(["name", "prompt"]),
  );
  const taken = nameTaken(agents.value, d.name.value, agent.id);
  // the oldest agent is where the default falls back, so unticking it
  // cannot move the mark; the server picks it by created_at, then name
  const oldest = (agents.value ?? []).reduce<AgentSummary | null>(
    (o, a) =>
      o === null ||
      a.createdAt < o.createdAt ||
      (a.createdAt === o.createdAt && a.name < o.name)
        ? a
        : o,
    null,
  );
  const kept = agent.default && oldest?.id === agent.id;
  return (
    <SettingForm
      save={save}
      check={() => at("name", nameProblem(d.name.value))}
    >
      <Setting
        title="Identity"
        foot={
          <DraftFoot
            save={save}
            dirty={d.generalDirty(agent)}
            blocked={taken || d.name.value.trim() === ""}
            locked={d.saving.value}
            hint={
              taken ? (
                <span class="error">@{d.name.value.trim()} is taken.</span>
              ) : undefined
            }
            onDiscard={() => d.resetGeneral(agent)}
          />
        }
      >
        <NameFields drafts={d} save={save} kept={kept} />
      </Setting>
    </SettingForm>
  );
}
