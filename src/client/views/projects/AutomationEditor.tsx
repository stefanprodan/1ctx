// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The automation editor, for a new automation and one that exists, in
// steps: its name, the task (the composer's box with its agent chip),
// memory, who marks a run, what it may use, a restart, when it runs and
// its limits. Anyone in the project saves and deletes; a save names the
// edit revision the form opened on, and when the row has moved on the
// draft stays until Reload replaces it with the saved row. The deadline
// starts at the server's limit, the value a run is held to when none is
// set.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { KNOWLEDGE, VISUALIZE, WEB } from "../../../shared/capabilities.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { RETENTION_DAYS } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { emailItem, switchItem } from "../../composer/Add.model.ts";
import { AgentPicker } from "../../composer/AgentPicker.tsx";
import {
  automationError,
  automationProject,
  automations,
  automationsError,
  createAutomation,
  deleteAutomation,
  reloadAutomation,
  runDeadlineMs,
  updateAutomation,
} from "../../data/automations.ts";
import { switchable, switchablesOf } from "../../data/capabilities.ts";
import { me } from "../../data/me.ts";
import { startingAgent } from "../../data/project-agents.ts";
import { project, projectError } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { automationHref } from "../../lib/hrefs.ts";
import { toggledId } from "../../lib/ids.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { browserZone } from "../../lib/zone.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { Page } from "../../ui/Page.tsx";
import { Section } from "../../ui/Section.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { AccessSection } from "./AccessSection.tsx";
import { AttentionSection } from "./AttentionSection.tsx";
import { ownerNote, staleFailure, staleWords } from "./AutomationEdit.model.ts";
import { EditorStart } from "./AutomationEditorStart.tsx";
import {
  automationFieldOf,
  automationPageOf,
  type Draft,
  dirtyOf,
  draftOf,
  followDeadlineLimit,
  MEMORY_MODES,
  pickMemory,
  requestOf,
  retiredPick,
} from "./Automations.model.ts";
import { NameField } from "./ProjectFields.tsx";
import { RestartSection } from "./RestartSection.tsx";
import { ScheduleField } from "./ScheduleField.tsx";
import "./automations.css";

function Editor({
  automation,
  projectId,
  agents,
  limitMs,
}: {
  automation: AutomationSummary | null;
  projectId: string;
  agents: AgentSummary[];
  // the run deadline limit, in ms
  limitMs: number;
}) {
  const draft = useSignal<Draft>(
    draftOf(automation, startingAgent(agents) ?? "", browserZone(), limitMs),
  );
  // the edit revision the draft started from: the row on the page moves
  // with every frame, so a save never sends that one
  const opened = useSignal(automation?.editRevision ?? 0);
  // set by a stale save, cleared only by a Reload that lands
  const stale = useSignal(false);
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
  // what the switches list, read when a call runs as the draft is
  const shown = () => switchablesOf(draft.value.agentId);
  const requestAt = (ms: number) => requestOf(draft.value, ms, shown());
  const request = requestAt(limitMs);
  const back =
    automation === null
      ? `/projects/${projectId}/automations`
      : automationHref(automation.id);
  // the call is kept from the first render, so it reads the draft's
  // signal when it runs rather than this render's request
  const save = useSave(async () => {
    const current = requestAt(limitRef.current);
    if (!("body" in current)) throw new Error(current.problem);
    const saved =
      automation === null
        ? await createAutomation(projectId, current.body)
        : await updateAutomation(automation.id, {
            ...current.body,
            editRevision: opened.value,
          }).catch((err: unknown) => {
            // latched here, before the notice shows: an edit or Reload
            // clears the notice, never this
            if (staleFailure(err)) stale.value = true;
            throw err;
          });
    navigate(automationHref(saved.id));
  }, automationFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const set = (patch: Partial<Draft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const remove = async (runs: boolean) => {
    if (automation === null) return;
    const id = automation.id;
    const action = runs ? "purge" : "delete";
    if (await save.act(action, () => deleteAutomation(id, runs))) {
      navigate(`/projects/${projectId}/automations`);
    }
  };
  // the saved row replaces the draft whole: no merge, the user makes
  // their change again
  const reload = async () => {
    if (automation === null) return;
    const id = automation.id;
    await save.act("reload", async () => {
      const saved = await reloadAutomation(id);
      draft.value = draftOf(saved, saved.agentId, saved.tz, limitRef.current);
      opened.value = saved.editRevision;
      stale.value = false;
      deadlineTouched.value = false;
    });
  };
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      "problem" in request
        ? { error: request.problem, field: request.field }
        : null,
    );
  };
  const busy = save.busy;
  const off = busy;
  const notice = save.notice();
  const isStale = stale.value;
  const note = ownerNote(automation, me.value?.id ?? null);
  const words = staleWords(isStale, notice);
  const d = draft.value;
  const takesTools =
    agents.find((a) => a.id === d.agentId)?.model.tools ?? true;
  // the saved agent was deleted: no save until another is picked
  const gone = retiredPick(automation, d.agentId);
  const live = agents.filter((a) => retiredPick(automation, a.id) === null);
  const input = { tools: takesTools, switchable: switchable.value, off: false };
  const kind = (key: string) => switchItem(key, input);
  return (
    <form class="automations-editor" ref={form} onSubmit={submit}>
      <Section title="Name" text="Unique in this project">
        <NameField
          disabled={off}
          error={save.fieldError("name")}
          value={d.name}
          onInput={(name) => set({ name })}
        />
      </Section>
      <Section title="Task" text="The first message of every run">
        <div class="field">
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
                agents={live}
                agentId={d.agentId}
                onPick={off ? undefined : (agentId) => set({ agentId })}
                ask={gone !== null}
              />
            </div>
            {gone !== null && (
              <span class="field-error" role="alert">
                {gone}
              </span>
            )}
          </div>
          <FieldError save={save} field="instructions" />
          <FieldError save={save} field="agent" />
        </div>
      </Section>
      <Section title="Memory" text="What a run remembers">
        <div class="field">
          <Seg
            label="Memory"
            invalid={invalid("memory")}
            name="memory"
            options={MEMORY_MODES.map((mode) => ({
              ...mode,
              disabled: off || (!takesTools && mode.value !== "none"),
            }))}
            value={d.memory}
            onPick={(value) => set(pickMemory(d, value))}
          />
          <FieldError save={save} field="memory" />
          {/* a refusal of the guidance keeps it in sight, or the save
              fails with nothing to show */}
          {((d.memory === "own" && takesTools) ||
            invalid("memoryGuidance")) && (
            <label class="field automations-guidance">
              <textarea
                name="memoryGuidance"
                aria-label="What to remember"
                rows={4}
                placeholder="What to remember"
                aria-invalid={invalid("memoryGuidance") || undefined}
                disabled={off}
                value={d.memoryGuidance}
                onInput={(e) =>
                  set({
                    memoryGuidance: (e.currentTarget as HTMLTextAreaElement)
                      .value,
                  })
                }
              />
              <FieldError save={save} field="memoryGuidance" />
            </label>
          )}
        </div>
      </Section>
      <AttentionSection
        draft={d}
        set={set}
        save={save}
        takesTools={takesTools}
        disabled={off}
      />
      <AccessSection
        web={kind(WEB)}
        webOn={d.web}
        onWeb={() => set({ web: !d.web })}
        visuals={kind(VISUALIZE)}
        visualsOn={d.visuals}
        onVisuals={() => set({ visuals: !d.visuals })}
        knowledge={kind(KNOWLEDGE)}
        knowledgeOn={d.knowledge}
        onKnowledge={() => set({ knowledge: !d.knowledge })}
        email={emailItem(input)}
        emailOn={d.email}
        onEmail={() => set({ email: !d.email })}
        servers={takesTools ? shown().servers : []}
        mcpOff={d.mcpOff}
        onServer={(key) => set({ mcpOff: toggledId(d.mcpOff, key) })}
        skills={takesTools ? shown().skills : []}
        skillsOff={d.skillsOff}
        onSkill={(key) => set({ skillsOff: toggledId(d.skillsOff, key) })}
        credentials={shown().credentials}
        credentialsOff={d.credentialsOff}
        onCredential={(key) =>
          set({ credentialsOff: toggledId(d.credentialsOff, key) })
        }
        repos={takesTools ? shown().repos : []}
        reposOff={d.reposOff}
        onRepo={(key) => set({ reposOff: toggledId(d.reposOff, key) })}
        disabled={off}
      />
      <RestartSection on={d.rerunOnRestart} set={set} disabled={off} />
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
        <div class="pair">
          <label class="field">
            <span class="label">Deadline</span>
            <NumberBox
              name="deadline"
              unit="min"
              invalid={invalid("deadline")}
              disabled={off}
              value={d.deadline}
              onInput={(text) => {
                deadlineTouched.value = true;
                set({ deadline: text });
              }}
            />
            <FieldError save={save} field="deadline" />
          </label>
          <label class="field">
            <span class="label">History retention</span>
            <NumberBox
              name="retention"
              unit="days"
              placeholder={String(RETENTION_DAYS.default)}
              invalid={invalid("retention")}
              disabled={off}
              value={d.retention}
              onInput={(text) => set({ retention: text })}
            />
            <FieldError save={save} field="retention" />
          </label>
        </div>
      </Section>
      <div class="automations-foot">
        <Foot
          save={save}
          dirty={dirtyOf(d, automation, limitMs) && gone === null}
          label={automation === null ? "Create scheduled task" : "Save"}
          above={
            <>
              {note !== null && !asking.value && (
                <p class="automations-owner-note">{note}</p>
              )}
              {words !== null && (
                <p class="error automations-stale" role="alert">
                  {words}
                </p>
              )}
            </>
          }
          start={
            automation === null ? (
              <span />
            ) : (
              <EditorStart
                save={save}
                asking={asking}
                stale={isStale}
                onReload={() => void reload()}
                onRemove={(runs) => void remove(runs)}
              />
            )
          }
          before={
            !asking.value && (
              <a class="btn" href={back}>
                Cancel
              </a>
            )
          }
        >
          {/* while Delete asks, its buttons are the only ones */}
          {asking.value ? <span /> : undefined}
        </Foot>
      </div>
    </form>
  );
}

// how a fire becomes a run, in the scheduler's and the runner's terms
const RUN_FACTS = [
  "Each run starts a new session where the agent works on its own, without asking questions.",
  "A scheduled run is skipped if the previous one is still running.",
  "When too many tasks are running, a scheduled run waits for one to finish, up to its next time.",
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
          />
        </Split>
      )}
    </Page>
  );
}

export function EditAutomation({ params }: { params: Params }) {
  const id = params.id ?? "";
  const { row, shown, error } = automationPageOf({
    id,
    rows: automations.value,
    found: automationProject.value,
    project: project.value,
    agentsIn: projectAgents.value !== null,
    failure:
      automationError.value ?? automationsError.value ?? projectError.value,
  });
  const agents = projectAgents.value;
  const limit = runDeadlineMs.value;
  const ready =
    row !== null && shown !== null && agents !== null && limit !== null;
  return (
    <Page
      crumb={row?.name ?? "Automation"}
      crumbHref={automationHref(id)}
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
          />
        </Split>
      )}
    </Page>
  );
}
