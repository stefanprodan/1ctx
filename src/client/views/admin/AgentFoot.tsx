// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's foot: Delete, Cancel and Save. Delete reads what it
// would do before it asks, and the ask says it on a line over the
// buttons: the chats it archives, the automations it pauses and what it
// stops. A read that fails asks without the line.

import { type Signal, useSignal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { agentImpact } from "../../data/agents.ts";
import type { Save } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { impactLine } from "./Agents.model.ts";

export function AgentFoot({
  agent,
  save,
  dirty,
  asking,
  onDelete,
  onDone,
}: {
  agent: AgentSummary | null;
  save: Save;
  dirty: boolean;
  asking: Signal<boolean>;
  onDelete: () => void;
  onDone: () => void;
}) {
  const impact = useSignal("");
  const read = async () => {
    if (agent === null) return;
    try {
      impact.value = impactLine(await agentImpact(agent.id));
    } catch {
      impact.value = "";
    }
  };
  return (
    <Foot
      save={save}
      dirty={dirty}
      label={agent ? "Save" : "Add agent"}
      above={
        asking.value &&
        impact.value !== "" && <p class="agents-ask-impact">{impact.value}</p>
      }
      start={
        agent === null ? (
          <span />
        ) : (
          <AskDelete
            save={save}
            asking={asking}
            busy={save.busy}
            words={`Delete ${agent.name}?`}
            wordsClass="agents-ask-words"
            onAsk={read}
            onDelete={onDelete}
          />
        )
      }
      before={
        <button type="button" class="btn" onClick={onDone}>
          Cancel
        </button>
      }
    />
  );
}
