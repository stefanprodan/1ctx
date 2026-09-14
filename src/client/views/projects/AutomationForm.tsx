// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's fields: the name and the agent, the instructions, the
// schedule and its zone, the deadline and how long runs are kept. The
// owner, or an admin in a team project, saves and deletes; anyone else
// reads the fields. The schedule's words under the field are only a
// reading of it; the server's 400 is the rule. The deadline starts at
// the server's limit, the value a run is held to when none is set.

import { useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { MAX_SCHEDULE, RETENTION_DAYS } from "../../../shared/words.ts";
import { AgentPicker } from "../../composer/AgentPicker.tsx";
import {
  createAutomation,
  deleteAutomation,
  updateAutomation,
} from "../../data/automations.ts";
import { reason } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  type Draft,
  dirtyOf,
  draftOf,
  followDeadlineLimit,
  requestOf,
  scheduleWords,
  zoneOptions,
} from "./Automations.model.ts";
import { NameField } from "./ProjectFields.tsx";
import "./automations.css";

// the zones the runtime knows; the server also takes the links this
// list leaves out
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
  limitMs,
  editable,
  onDone,
}: {
  automation: AutomationSummary | null;
  projectId: string;
  agents: AgentSummary[];
  // the run deadline limit, in ms
  limitMs: number;
  // false shows the fields to read, with no foot
  editable: boolean;
  onDone: () => void;
}) {
  const draft = useSignal<Draft>(
    draftOf(automation, agents[0]?.id ?? "", browserZone(), limitMs),
  );
  const asking = useSignal(false);
  const deleting = useSignal(false);
  const deadlineTouched = useSignal(false);
  const failure = useSignal<string | null>(null);
  const limitRef = useRef(limitMs);
  limitRef.current = limitMs;
  useEffect(() => {
    const next = followDeadlineLimit(
      draft.value,
      deadlineTouched.value,
      automation,
      limitMs,
    );
    if (next !== draft.value) draft.value = next;
  }, [automation?.deadlineMs, limitMs]);
  const request = requestOf(draft.value, limitMs);
  // the call is kept from the first render, so it reads the draft's
  // signal when it runs rather than this render's request
  const save = useSave(async () => {
    const current = requestOf(draft.value, limitRef.current);
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
  // the offsets are read when the zone moves, not on every keystroke
  const zones = useMemo(() => zoneOptions(ZONES, d.tz, Date.now()), [d.tz]);
  return (
    <form class="automations-form" onSubmit={submit}>
      <div class="automations-pair">
        <NameField
          placeholder="nightly-check"
          disabled={off}
          value={d.name}
          onInput={(name) => set({ name })}
        />
        <div class="field">
          <span class="label">Agent</span>
          <AgentPicker
            agents={agents}
            agentId={d.agentId}
            field
            onPick={off ? undefined : (agentId) => set({ agentId })}
          />
        </div>
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
        <div class="field">
          <span class="label">Time zone</span>
          <Select
            label="Time zone"
            value={d.tz}
            options={zones}
            disabled={off}
            search
            onChange={(tz) => set({ tz })}
          />
        </div>
      </div>
      <div class="automations-pair">
        <label class="field">
          <span class="label">Deadline (in minutes)</span>
          <input
            name="deadline"
            inputMode="decimal"
            autocomplete="off"
            disabled={off}
            value={d.deadline}
            onInput={(e) => {
              deadlineTouched.value = true;
              set({ deadline: (e.currentTarget as HTMLInputElement).value });
            }}
          />
        </label>
        <label class="field">
          <span class="label">History retention (in days)</span>
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
        </label>
      </div>
      {editable ? (
        <div class={automation === null ? undefined : "automations-foot"}>
          <Foot
            status={deleting.value ? "busy" : save.status.value}
            dirty={dirtyOf(d, automation, limitMs)}
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
