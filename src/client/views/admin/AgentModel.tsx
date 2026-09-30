// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { updateAgent } from "../../data/agents.ts";
import { providers } from "../../data/providers.ts";
import { useSave } from "../../lib/save.ts";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { cardBody, cardFieldOf } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import { ModelFields } from "./ModelFields.tsx";

export function AgentModel({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  // read at call time: the save is made once, maybe before the providers
  // loaded, and a wire it cannot see drops the effort and upstream
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
    cardFieldOf(["model", "upstream", "skip4Bit", "contextLength"]),
  );
  const changing = d.changing.value;
  return (
    <SettingForm save={save} check={() => d.modelProblem()}>
      <Setting
        title="Model"
        foot={
          <DraftFoot
            locked={d.saving.value}
            save={save}
            dirty={d.modelDirty(agent, wireOf())}
            blocked={changing || d.model.value === null}
            open={changing}
            onDiscard={() => d.resetModel(latest.current)}
          />
        }
      >
        <ModelFields drafts={d} save={save} currentId={agent.model.id} />
      </Setting>
    </SettingForm>
  );
}
