// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's Subagents switch, drawn as the Visuals switch is: a flip
// saves only on Save. A model without tools cannot turn it on; one
// already on may still be turned off.

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { updateAgent } from "../../data/agents.ts";
import { useSave } from "../../lib/save.ts";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { cardBody } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";

const TITLE = "Subagents";

const SUBAGENTS_LINE =
  "Turns and runs may hand a task to a fresh copy of this agent.";

const NO_TOOLS = "The model does not take tools";

export function AgentSubagents({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  const save = useSave(() =>
    d.save(async () => {
      const saved = await updateAgent(
        latest.current.id,
        cardBody(
          latest.current,
          { subagents: d.subagents.value },
          loadedRows(),
        ),
      );
      d.resetSubagents(saved);
    }),
  );
  const on = d.subagents.value;
  const locked = !on && !agent.model.tools;
  return (
    <SettingForm save={save}>
      <Setting
        title={TITLE}
        line={SUBAGENTS_LINE}
        action={
          <RowsSwitch
            on={on}
            label={TITLE}
            name="subagents"
            disabled={save.busy || locked}
            title={locked ? NO_TOOLS : undefined}
            onClick={() => {
              d.subagents.value = !on;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={d.subagentsDirty(agent)}
            locked={d.saving.value}
            onDiscard={() => d.resetSubagents(latest.current)}
          />
        }
      />
    </SettingForm>
  );
}
