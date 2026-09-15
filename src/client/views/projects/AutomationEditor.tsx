// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The automation editor, a page for a new automation and for one that
// exists, in steps: its name, the task (the composer's box with its
// agent chip, since a run is that message to that agent), when it runs
// and its limits. The owner, or an admin in a team project, saves and
// deletes; anyone else reads the fields. The deadline starts at the
// server's limit, the value a run is held to when none is set.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { RETENTION_DAYS } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { AgentPicker } from "../../composer/AgentPicker.tsx";
import {
  automationError,
  automationProject,
  automations,
  automationsError,
  createAutomation,
  deleteAutomation,
  runDeadlineMs,
  updateAutomation,
} from "../../data/automations.ts";
import { me } from "../../data/me.ts";
import { project, projectError } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Section } from "../../ui/Section.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import {
  automationFieldOf,
  browserZone,
  canChange,
  type Draft,
  dirtyOf,
  draftOf,
  followDeadlineLimit,
  requestOf,
} from "./Automations.model.ts";
import { NameField } from "./ProjectFields.tsx";
import { ScheduleField } from "./ScheduleField.tsx";
import "./automations.css";

function Editor({
  automation,
  projectId,
  agents,
  limitMs,
  editable,
}: {
  automation: AutomationSummary | null;
  projectId: string;
  agents: AgentSummary[];
  // the run deadline limit, in ms
  limitMs: number;
  // false shows the fields to read, with no foot
  editable: boolean;
}) {
  const draft = useSignal<Draft>(
    draftOf(automation, agents[0]?.id ?? "", browserZone(), limitMs),
  );
  const asking = useSignal(false);
  const deadlineTouched = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
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
  const back =
    automation === null
      ? `/projects/${projectId}/automations`
      : `/automations/${automation.id}`;
  // the call is kept from the first render, so it reads the draft's
  // signal when it runs rather than this render's request
  const save = useSave(async () => {
    const current = requestOf(draft.value, limitRef.current);
    if (!("body" in current)) throw new Error(current.problem);
    const saved =
      automation === null
        ? await createAutomation(projectId, current.body)
        : await updateAutomation(automation.id, current.body);
    navigate(`/automations/${saved.id}`);
  }, automationFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const set = (patch: Partial<Draft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const remove = async () => {
    if (automation === null) return;
    const id = automation.id;
    if (await save.act("delete", () => deleteAutomation(id))) {
      navigate(`/projects/${projectId}/automations`);
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (!editable) return;
    void save.run(
      "problem" in request
        ? { error: request.problem, field: request.field }
        : null,
    );
  };
  const busy = save.busy;
  const off = busy || !editable;
  const d = draft.value;
  return (
    <form class="automations-editor" ref={form} onSubmit={submit}>
      {!editable && (
        <p class="automations-note">
          Its owner or an admin changes it. You can run, suspend and resume it.
        </p>
      )}
      <Section title="Name" text="Unique in this project">
        <NameField
          disabled={off}
          error={save.fieldError("name")}
          value={d.name}
          onInput={(name) => set({ name })}
        />
      </Section>
      <Section title="Task" text="The first message of every run">
        <div class="automations-stack">
          <div
            class={`automations-task${invalid("instructions") || invalid("agent") ? " automations-task-invalid" : ""}`}
          >
            <textarea
              name="instructions"
              class="automations-task-text"
              aria-label="Instructions"
              aria-invalid={invalid("instructions") || undefined}
              placeholder="Instructions for the agent"
              rows={5}
              disabled={off}
              value={d.instructions}
              onInput={(e) =>
                set({
                  instructions: (e.currentTarget as HTMLTextAreaElement).value,
                })
              }
            />
            <div class="automations-task-bar">
              <AgentPicker
                agents={agents}
                agentId={d.agentId}
                onPick={off ? undefined : (agentId) => set({ agentId })}
              />
            </div>
          </div>
          <FieldError save={save} field="instructions" />
          <FieldError save={save} field="agent" />
        </div>
      </Section>
      <Section title="When" text="In the time zone you pick">
        <ScheduleField
          projectId={projectId}
          schedule={d.schedule}
          tz={d.tz}
          disabled={off}
          invalidTz={invalid("tz")}
          onSchedule={(schedule) => set({ schedule })}
          onTz={(tz) => set({ tz })}
        />
        <FieldError save={save} field="schedule" />
        <FieldError save={save} field="tz" />
      </Section>
      <Section
        title="Limits"
        text="When a run is stopped, and how long runs are kept"
      >
        <div class="automations-pair">
          <label class="field">
            <span class="label">Deadline (in minutes)</span>
            <input
              name="deadline"
              inputMode="decimal"
              autocomplete="off"
              aria-invalid={invalid("deadline") || undefined}
              disabled={off}
              value={d.deadline}
              onInput={(e) => {
                deadlineTouched.value = true;
                set({ deadline: (e.currentTarget as HTMLInputElement).value });
              }}
            />
            <FieldError save={save} field="deadline" />
          </label>
          <label class="field">
            <span class="label">History retention (in days)</span>
            <input
              name="retention"
              inputMode="numeric"
              autocomplete="off"
              placeholder={String(RETENTION_DAYS.default)}
              aria-invalid={invalid("retention") || undefined}
              disabled={off}
              value={d.retention}
              onInput={(e) =>
                set({ retention: (e.currentTarget as HTMLInputElement).value })
              }
            />
            <FieldError save={save} field="retention" />
          </label>
        </div>
      </Section>
      <div class="automations-foot">
        {editable ? (
          <Foot
            save={save}
            dirty={dirtyOf(d, automation, limitMs)}
            label={automation === null ? "Create scheduled task" : "Save"}
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
                    {save.pending.value === "delete" ? "Deleting" : "Delete"}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => {
                      asking.value = false;
                      save.touch();
                    }}
                  >
                    Keep
                  </button>
                  <span class="automations-note">Its runs stay</span>
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
              <a class="btn" href={back}>
                Cancel
              </a>
            }
          />
        ) : (
          <a class="btn" href={back}>
            Back
          </a>
        )}
      </div>
    </form>
  );
}

// how a fire becomes a run, in the scheduler's and the runner's terms
const RUN_FACTS = [
  "Each run starts a new session where the agent works on its own, without asking questions.",
  "A scheduled run is skipped if the previous one is still running.",
  "A run that exceeds the deadline is stopped.",
  "Runs are deleted after the retention period.",
];

const aside = (
  <AsideSection label="How it works">
    {RUN_FACTS.map((fact) => (
      <p key={fact} class="automations-aside-text">
        {fact}
      </p>
    ))}
  </AsideSection>
);

export function NewAutomation({ params }: { params: Params }) {
  const id = params.id ?? "";
  const shown = project.value?.id === id ? project.value : null;
  const agents = projectAgents.value;
  const limit = runDeadlineMs.value;
  const error = projectError.value ?? automationsError.value;
  const ready = shown !== null && agents !== null && limit !== null;
  return (
    <Page
      crumb={shown?.name ?? "Project"}
      crumbHref={`/projects/${id}/automations`}
      title="New scheduled task"
      loading={!ready && error === null}
      error={error}
      empty={
        ready && agents.length === 0
          ? "No agents yet. An admin adds one first."
          : undefined
      }
    >
      {ready && (
        <Split aside={aside}>
          <Editor
            key={id}
            automation={null}
            projectId={id}
            agents={agents}
            limitMs={limit}
            editable
          />
        </Split>
      )}
    </Page>
  );
}

export function EditAutomation({ params }: { params: Params }) {
  const id = params.id ?? "";
  const row = automations.value?.find((a) => a.id === id) ?? null;
  const found = automationProject.value;
  const projectId = found?.id === id ? found.projectId : null;
  const shown =
    project.value !== null && project.value.id === projectId
      ? project.value
      : null;
  const agents = projectAgents.value;
  const limit = runDeadlineMs.value;
  const gone =
    row === null &&
    projectId !== null &&
    automations.value !== null &&
    agents !== null;
  const error =
    automationError.value ??
    automationsError.value ??
    projectError.value ??
    (gone ? "This automation was deleted." : null);
  const ready =
    row !== null && shown !== null && agents !== null && limit !== null;
  return (
    <Page
      crumb={row?.name ?? "Automation"}
      crumbHref={`/automations/${id}`}
      title="Edit"
      loading={!ready && error === null}
      error={error}
    >
      {ready && (
        <Split aside={aside}>
          <Editor
            key={row.id}
            automation={row}
            projectId={row.projectId}
            agents={agents}
            limitMs={limit}
            editable={canChange(row, me.value ?? null, shown.kind)}
          />
        </Split>
      )}
    </Page>
  );
}
