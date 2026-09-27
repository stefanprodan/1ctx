// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's Model card, one draft with one Save since its fields
// depend on each other; the fields are `ModelFields`, shared with New
// agent.

import { useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { updateAgent } from "../../data/agents.ts";
import { providers } from "../../data/providers.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { Setting } from "../../ui/Setting.tsx";
import { cardBody, cardFieldOf } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { ModelFields } from "./ModelFields.tsx";

export function AgentModel({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useRef(agent);
  latest.current = agent;
  // read when it runs: the save is made once, before the providers may
  // have loaded, and a wire it cannot see drops the effort and upstream
  const wireOf = () =>
    providers.value?.find((p) => p.id === d.providerId.value)?.wire;
  const save = useSave(
    () =>
      d.save(async () => {
        const saved = await updateAgent(
          latest.current.id,
          cardBody(latest.current, d.modelBody(wireOf()), loadedRows()),
        );
        d.resetModel(saved);
      }),
    cardFieldOf(["model", "upstream", "contextLength"]),
  );
  const card = useRef<HTMLFormElement>(null);
  useFocusField(save, card);
  const dirty = d.modelDirty(agent, wireOf());
  const changing = d.changing.value;
  const discard = () => d.resetModel(latest.current);
  return (
    <form
      ref={card}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(d.modelProblem());
      }}
    >
      <Setting
        title="Model"
        foot={
          <DraftFoot
            locked={d.saving.value}
            save={save}
            dirty={dirty}
            blocked={changing || d.model.value === null}
            open={changing}
            onDiscard={discard}
          />
        }
      >
        <ModelFields drafts={d} save={save} currentId={agent.model.id} />
      </Setting>
    </form>
  );
}
