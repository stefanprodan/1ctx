// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's fields: the name and the agent, the instructions, the
// schedule and its zone, the deadline and how long runs are kept. The
// owner, or an admin in a team project, saves and deletes; anyone else
// reads the fields. The schedule's words under the field are only a
// reading of it; the server's 400 is the rule.

import { useSignal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { MAX_SCHEDULE, MAX_TZ, RETENTION_DAYS } from "../../../shared/words.ts";
import {
  createAutomation,
  deleteAutomation,
  updateAutomation,
} from "../../data/automations.ts";
import { reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import {
  type Draft,
  dirtyOf,
  draftOf,
  requestOf,
  scheduleWords,
} from "./Automations.model.ts";
import { NameField } from "./ProjectFields.tsx";
import "./automations.css";

// the zones the runtime knows, for the field's suggestions; the server
// also takes the links this list leaves out
const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

export const browserZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export function AutomationForm({
  automation,
  projectId,
  agents,
  editable,
  onDone,
}: {
  automation: AutomationSummary | null;
  projectId: string;
  agents: AgentSummary[];
  // false shows the fields to read, with no foot
  editable: boolean;
  onDone: () => void;
}) {
  const draft = useSignal<Draft>(
    draftOf(automation, agents[0]?.id ?? "", browserZone()),
  );
  const asking = useSignal(false);
  const deleting = useSignal(false);
  const failure = useSignal<string | null>(null);
  const request = requestOf(draft.value);
  // the call is kept from the first render, so it reads the draft's
  // signal when it runs rather than this render's request
  const save = useSave(async () => {
    const current = requestOf(draft.value);
    if (!("body" in current)) throw new Error(current.problem);
    if (automation === null) {
      await createAutomation(projectId, current.body);
      onDone();
    } else await updateAutomation(automation.id, current.body);
  });
  const set = (patch: Partial<Draft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const remove = async () => {
    if (automation === null || deleting.value) return;
    deleting.value = true;
    failure.value = null;
    try {
      await deleteAutomation(automation.id);
    } catch (err) {
      failure.value = reason(err);
      deleting.value = false;
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (!editable || deleting.value) return;
    void save.run("problem" in request ? request.problem : null);
  };
  const busy = save.status.value === "busy" || deleting.value;
  const off = busy || !editable;
  const d = draft.value;
  const words = scheduleWords(d.schedule);
  const agentGone = d.agentId !== "" && !agents.some((a) => a.id === d.agentId);
  return (
    <form class="automations-form" onSubmit={submit}>
      <div class="automations-pair">
        <NameField
          placeholder="nightly-check"
          disabled={off}
          value={d.name}
          onInput={(name) => set({ name })}
        />
        <label class="field">
          <span class="label">Agent</span>
          <span class="automations-select">
            <select
              name="agent"
              class="automations-select-input"
              disabled={off}
              onChange={(e) =>
                set({ agentId: (e.currentTarget as HTMLSelectElement).value })
              }
            >
              {agentGone && (
                <option value={d.agentId} selected>
                  an agent that is gone
                </option>
              )}
              {agents.map((a) => (
                // Preact sets no default on a select, so the option
                // carries the selection
                <option key={a.id} value={a.id} selected={d.agentId === a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={14} class="automations-select-chevron" />
          </span>
        </label>
      </div>
      <label class="field">
        <span class="label">Instructions</span>
        <textarea
          name="instructions"
          class="automations-instructions"
          rows={5}
          disabled={off}
          placeholder="What the agent does at every run"
          value={d.instructions}
          onInput={(e) =>
            set({
              instructions: (e.currentTarget as HTMLTextAreaElement).value,
            })
          }
        />
      </label>
      <div class="automations-pair">
        <label class="field">
          <span class="label">Schedule</span>
          <input
            name="schedule"
            class="automations-mono"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_SCHEDULE}
            placeholder="0 9 * * MON-FRI"
            disabled={off}
            value={d.schedule}
            onInput={(e) =>
              set({ schedule: (e.currentTarget as HTMLInputElement).value })
            }
          />
          <span class="hint">
            {words === null ? "A cron expression" : `Runs ${words}`}
          </span>
        </label>
        <label class="field">
          <span class="label">Zone</span>
          <input
            name="tz"
            class="automations-mono"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_TZ}
            list="automations-zones"
            disabled={off}
            value={d.tz}
            onInput={(e) =>
              set({ tz: (e.currentTarget as HTMLInputElement).value })
            }
          />
          <datalist id="automations-zones">
            {ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
      </div>
      <div class="automations-pair">
        <label class="field">
          <span class="label">Deadline</span>
          <input
            name="deadline"
            inputMode="numeric"
            autocomplete="off"
            placeholder="The server's limit"
            disabled={off}
            value={d.deadline}
            onInput={(e) =>
              set({ deadline: (e.currentTarget as HTMLInputElement).value })
            }
          />
          <span class="hint">Minutes a run may take</span>
        </label>
        <label class="field">
          <span class="label">Keep runs</span>
          <input
            name="retention"
            inputMode="numeric"
            autocomplete="off"
            placeholder={String(RETENTION_DAYS.default)}
            disabled={off}
            value={d.retention}
            onInput={(e) =>
              set({ retention: (e.currentTarget as HTMLInputElement).value })
            }
          />
          <span class="hint">Days, then a run is deleted</span>
        </label>
      </div>
      {editable ? (
        <div class={automation === null ? undefined : "automations-foot"}>
          <Foot
            status={deleting.value ? "busy" : save.status.value}
            dirty={dirtyOf(d, automation)}
            label={automation === null ? "New automation" : "Save"}
            start={
              automation === null ? (
                <span />
              ) : asking.value ? (
                <>
                  <button
                    type="button"
                    class="btn btn-danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {deleting.value ? "Deleting" : "Delete"}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => {
                      asking.value = false;
                      failure.value = null;
                    }}
                  >
                    Keep
                  </button>
                  <span
                    class={`automations-note${failure.value ? " error" : ""}`}
                  >
                    {failure.value ?? "Its runs stay"}
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  class="btn"
                  disabled={busy}
                  onClick={() => {
                    asking.value = true;
                  }}
                >
                  Delete
                </button>
              )
            }
            before={
              <button
                type="button"
                class="btn"
                disabled={busy}
                onClick={onDone}
              >
                {automation === null ? "Cancel" : "Close"}
              </button>
            }
          />
        </div>
      ) : (
        <p class="automations-note">
          Its owner or an admin changes it. You can run, suspend and resume it.
        </p>
      )}
    </form>
  );
}
