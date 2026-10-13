// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The brief of an external task, for a new one on its own page and for
// an edit in place on the task's page: the title and its scope, the
// text, and the knowledge files the agent reads, picked from the
// project's. An edit sends what changed and the edit revision the form
// opened on; a brief changed since is refused with the server's words
// and the draft stays.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import {
  type ExternalTaskDetail,
  MAX_TASK_FILES,
} from "../../../shared/contracts/external-task.ts";
import { MAX_TITLE } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import {
  createExternalTask,
  editExternalTask,
} from "../../data/external-task.ts";
import { knowledgeOf, listErrors } from "../../data/knowledge.ts";
import { project, projectError } from "../../data/projects.ts";
import { externalTaskHref, externalTasksHref } from "../../lib/hrefs.ts";
import { useArrivalFocus, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Finder } from "../../ui/Finder.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  RowsEnd,
  RowsLine,
  RowsList,
  RowsNote,
  RowsRemove,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { Split } from "../../ui/Split.tsx";
import {
  type Draft,
  dirtyOf,
  draftOf,
  fileLabel,
  patchOf,
  requestOf,
  taskFieldOf,
} from "./ExternalTasks.model.ts";
import "./external-tasks.css";

export function TaskForm({
  projectId,
  detail,
  onCancel,
  onSaved,
}: {
  projectId: string;
  // the task an edit opened on, null for a new one
  detail: ExternalTaskDetail | null;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const draft = useSignal<Draft>(draftOf(detail));
  // the edit revision the form opened on: the task on the page moves
  // with every frame, so a save never sends that one
  const opened = useSignal(detail?.task.editRevision ?? 0);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const current = requestOf(draft.value);
    if (!("body" in current)) throw new Error(current.problem);
    const answer =
      detail === null
        ? await createExternalTask(projectId, current.body)
        : await editExternalTask(
            detail.task.id,
            patchOf(current.body, detail, opened.value),
          );
    onSaved(answer.task.task.id);
  }, taskFieldOf);
  useFocusField(save, form);
  useArrivalFocus(form, "title");
  const set = (patch: Partial<Draft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const d = draft.value;
  const off = save.busy;
  const invalid = (field: string) => save.fieldError(field) !== null;
  const files = knowledgeOf(projectId)?.files ?? null;
  const filesError = listErrors.value.get(projectId) ?? null;
  // a linked file is named by the project's list, else by the link the
  // task holds, which keeps a deleted file's name
  const nameOf = (id: string) => {
    const live = files?.find((f) => f.id === id);
    if (live !== undefined) return live.name;
    const link = detail?.files.find((f) => f.fileId === id);
    return link === undefined ? "a deleted file" : fileLabel(link);
  };
  const full = d.fileIds.length >= MAX_TASK_FILES;
  const submit = (event: Event) => {
    event.preventDefault();
    const request = requestOf(d);
    void save.run(
      "problem" in request
        ? { error: request.problem, field: request.field }
        : null,
    );
  };
  return (
    <form class="external-tasks-form" ref={form} onSubmit={submit}>
      <Section title="Task" text="The agent's goal">
        <div class="pair">
          <label class="field">
            <span class="label label-required">Title</span>
            <input
              name="title"
              aria-required="true"
              aria-invalid={invalid("title") || undefined}
              autocomplete="off"
              maxLength={MAX_TITLE}
              disabled={off}
              value={d.title}
              onInput={(e) =>
                set({ title: (e.currentTarget as HTMLInputElement).value })
              }
            />
            <FieldError save={save} field="title" />
          </label>
        </div>
      </Section>
      <Section title="Files" text="Knowledge files the agent reads">
        <div class="field">
          <RowsList>
            {d.fileIds.length === 0 && <RowsNote>No files linked.</RowsNote>}
            {d.fileIds.map((id) => (
              <RowsLine key={id} flush>
                <RowsTitle name={nameOf(id)} mono />
                <RowsEnd>
                  <RowsRemove
                    name={nameOf(id)}
                    disabled={off}
                    onRemove={() =>
                      set({ fileIds: d.fileIds.filter((f) => f !== id) })
                    }
                  />
                </RowsEnd>
              </RowsLine>
            ))}
          </RowsList>
          <div class="external-tasks-pick">
            <Finder
              label="Files"
              add="Link file"
              disabled={off || full || files === null}
              title={full ? `At most ${MAX_TASK_FILES} files` : undefined}
              options={(files ?? [])
                .filter((f) => !d.fileIds.includes(f.id))
                .map((f) => ({ value: f.id, label: f.name }))}
              mono
              align="left"
              placeholder="Find a file"
              none="No file matches"
              empty={
                filesError !== null
                  ? filesError.words
                  : "No knowledge files to link"
              }
              onPick={(id) => set({ fileIds: [...d.fileIds, id] })}
            />
          </div>
          <FieldError save={save} field="files" />
        </div>
      </Section>
      <div class="external-tasks-foot">
        <Foot
          save={save}
          dirty={dirtyOf(d, detail)}
          label={detail === null ? "Create external task" : "Save"}
          before={
            <button type="button" class="btn" disabled={off} onClick={onCancel}>
              Cancel
            </button>
          }
        />
      </div>
    </form>
  );
}

export function NewExternalTask({ params }: { params: Params }) {
  const id = params.id ?? "";
  const shown = project.value?.id === id ? project.value : null;
  const error = projectError.value;
  return (
    <Page
      crumb={shown?.name ?? "Project"}
      crumbHref={externalTasksHref(id)}
      title="New external task"
      loading={shown === null && error === null}
      error={error}
    >
      {shown !== null && (
        <Split aside={null}>
          <TaskForm
            key={id}
            projectId={id}
            detail={null}
            onCancel={() => navigate(externalTasksHref(id))}
            onSaved={(taskId) => navigate(externalTaskHref(taskId))}
          />
        </Split>
      )}
    </Page>
  );
}
