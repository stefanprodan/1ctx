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
import { configAgentHref } from "../../lib/hrefs.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { Setting, SettingDelete, SettingForm } from "../../ui/Setting.tsx";
import { AgentModel } from "./AgentModel.tsx";
import {
  cardBody,
  cardFieldOf,
  deleteLine,
  nameTaken,
} from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
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
      <SettingDelete
        title={`Delete @${agent.name}`}
        line={deleteLine(factsFor(agent.id)?.impact ?? null)}
        ask={`Delete @${agent.name}?`}
        off={drafts.saving.value}
        onAsk={() => loadFacts(agent.name)}
        onDelete={() => deleteAgent(agent.id)}
        leaveTo="/admin/config/agents"
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
  const taken = nameTaken(d.name.value, agents.value, agent.id);
  const kept = agent.default && agents.value?.[0]?.id === agent.id;
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
