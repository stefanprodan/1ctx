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
import { reason } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Section } from "../../ui/Section.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import {
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
      navigate(`/projects/${projectId}/automations`);
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
  return (
    <form class="automations-editor" onSubmit={submit}>
      {!editable && (
        <p class="automations-note">
          Its owner or an admin changes it. You can run, suspend and resume it.
        </p>
      )}
      <Section title="Name" text="Unique in this project">
        <NameField
          disabled={off}
          value={d.name}
          onInput={(name) => set({ name })}
        />
      </Section>
      <Section title="Task" text="The first message of every run">
        <div class="automations-task">
          <textarea
            name="instructions"
            class="automations-task-text"
            aria-label="Instructions"
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
      </Section>
      <Section title="When" text="In the time zone you pick">
        <ScheduleField
          projectId={projectId}
          schedule={d.schedule}
          tz={d.tz}
          disabled={off}
          onSchedule={(schedule) => set({ schedule })}
          onTz={(tz) => set({ tz })}
        />
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
      </Section>
      <div class="automations-foot">
        {editable ? (
          <Foot
            status={deleting.value ? "busy" : save.status.value}
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
  "Each fire opens a new session in this project with the chosen agent.",
  "The system prompt carries the agent's prompt, the project, the fire time in the zone and the autonomous run rule. The task is the first user message.",
  "A scheduled run acts as the owner. Run now acts as whoever pressed it. Both count against the send caps.",
  "A fire is skipped while the previous run is still running. Missed fires are dropped, never replayed.",
  "The deadline terminates the run as stopped. Runs past the retention are deleted hourly.",
];

const aside = (
  <AsideSection label="How it runs">
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
