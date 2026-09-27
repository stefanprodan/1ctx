// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's General tab: the name and avatar side by side with the
// system prompt and the default mark under them, one Save for the four;
// the model; and Delete, last, saying what goes with it and asking in
// its foot.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { navigate } from "../../app/router.ts";
import {
  agents,
  deleteAgent,
  facts,
  loadFacts,
  updateAgent,
} from "../../data/agents.ts";
import { configAgentHref } from "../../lib/hrefs.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AgentModel } from "./AgentModel.tsx";
import {
  cardBody,
  cardFieldOf,
  deleteLine,
  nameTaken,
} from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
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
      <DeleteCard agent={agent} drafts={drafts} />
    </>
  );
}

function Identity({
  agent,
  drafts,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  // the save is made once, so it reads the latest row when it runs
  const latest = useRef(agent);
  latest.current = agent;
  const d = drafts;
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
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const dirty = d.generalDirty(agent);
  const taken = nameTaken(d.name.value, agents.value, agent.id);
  const kept = agent.default && agents.value?.[0]?.id === agent.id;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(at("name", nameProblem(d.name.value)));
      }}
    >
      <Setting
        title="Identity"
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
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
    </form>
  );
}

function DeleteCard({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const impact = facts.value?.agentId === agent.id ? facts.value.impact : null;
  // Escape takes the ask back
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking.value]);
  return (
    <Setting
      danger
      title={`Delete @${agent.name}`}
      line={deleteLine(impact)}
      foot={
        <Foot save={save}>
          <div class="agent-page-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy || d.saving.value}
              words={`Delete @${agent.name}?`}
              wordsClass="agent-page-ask"
              onAsk={() => loadFacts(agent.name)}
              // the list drops the agent as the call ends, which takes
              // this card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  await deleteAgent(agent.id);
                  navigate("/config/agents");
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}
