// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The brief of an external task, for a new one on its own page and for
// an edit in place on the task's page: the title, 1 to 3 of the
// project's labels, and the 1 to 5 knowledge files the agent reads,
// linked from the project's or made here. An edit sends what changed
// and the edit revision the form opened on; a brief changed since is
// refused with the server's words and the draft stays. A task whose
// labels were all deleted opens asking for one, since the server
// refuses any edit of it until it has one.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import {
  type ExternalTaskDetail,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
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
import { Icon } from "../../lib/icons.tsx";
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
import { NewTaskFile } from "./ExternalTaskNewFile.tsx";
import {
  type Draft,
  dirtyOf,
  draftOf,
  fileLabel,
  labelIdsOf,
  labelNamesOf,
  NO_LABEL,
  patchOf,
  pickLabel,
  requestOf,
  taskFieldOf,
  withFile,
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
  // the labels are held by id, from the project's list as the form first
  // has it, so a label renamed while the form is open is shown and sent
  // by its new name, and a new label taking an old name is another one
  const projectLabels = () =>
    project.value?.id === projectId ? project.value.labels : null;
  const startIds = useRef<string[] | null>(null);
  const pickedIds = useSignal<string[] | null>(null);
  const labelIds = () => pickedIds.value ?? startIds.current;
  const live = (): Draft => {
    const ids = labelIds();
    const labels = projectLabels();
    return ids === null || labels === null
      ? draft.value
      : { ...draft.value, labels: labelNamesOf(ids, labels) };
  };
  // a file being made inline: the task waits for it to be linked
  const creating = useSignal(false);
  const save = useSave(async () => {
    const current = requestOf(live());
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
  const current = projectLabels();
  if (startIds.current === null && current !== null) {
    startIds.current = labelIdsOf(draft.value.labels, current);
  }
  const setLabels = (ids: string[]) => {
    pickedIds.value = ids;
    save.touch();
  };
  const d = live();
  const ids = labelIds();
  const off = save.busy || creating.value;
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
  const newFile = useSignal(false);
  const labelsFull = d.labels.length >= MAX_TASK_LABELS;
  // a task whose labels were all deleted asks for one from the start
  const needsLabel =
    detail !== null &&
    d.labels.length === 0 &&
    save.fieldError("labels") === null;
  const submit = (event: Event) => {
    event.preventDefault();
    if (creating.value) return;
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
      <Section title="Labels" text="What kind of work it is">
        <div class="field">
          <RowsList>
            {d.labels.length === 0 && <RowsNote>No labels picked.</RowsNote>}
            {(ids === null || current === null
              ? d.labels.map((name) => ({ id: null, name }))
              : ids.flatMap((id) => {
                  const name = current.find((l) => l.id === id)?.name;
                  return name === undefined ? [] : [{ id, name }];
                })
            ).map(({ id, name }) => (
              <RowsLine key={name} flush>
                <RowsTitle name={name} mono />
                <RowsEnd>
                  <RowsRemove
                    name={name}
                    disabled={off || id === null}
                    onRemove={() =>
                      setLabels((labelIds() ?? []).filter((l) => l !== id))
                    }
                  />
                </RowsEnd>
              </RowsLine>
            ))}
          </RowsList>
          <div class="external-tasks-pick">
            <Finder
              label="Labels"
              add="Add label"
              disabled={off || labelsFull || current === null || ids === null}
              title={
                labelsFull ? `At most ${MAX_TASK_LABELS} labels` : undefined
              }
              options={(current ?? [])
                .filter((label) => !(ids ?? []).includes(label.id))
                .map((label) => ({ value: label.id, label: label.name }))}
              mono
              align="left"
              placeholder="Find a label"
              none="No label matches"
              empty="No labels left to pick"
              onPick={(id) =>
                setLabels(
                  pickLabel(labelIds() ?? [], id, projectLabels() ?? []),
                )
              }
            />
          </div>
          {needsLabel ? (
            <span class="field-error">{NO_LABEL}</span>
          ) : (
            <FieldError save={save} field="labels" />
          )}
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
            <button
              type="button"
              class="btn btn-small"
              disabled={off || full || newFile.value}
              title={full ? `At most ${MAX_TASK_FILES} files` : undefined}
              onClick={() => {
                newFile.value = true;
              }}
            >
              <Icon name="pencil" size={12} />
              New file
            </button>
          </div>
          {newFile.value && (
            <NewTaskFile
              projectId={projectId}
              disabled={save.busy}
              onCreating={(busy) => {
                creating.value = busy;
              }}
              onCreated={(id) => {
                newFile.value = false;
                set(withFile(live(), id));
              }}
              onClose={() => {
                newFile.value = false;
              }}
            />
          )}
          <FieldError save={save} field="files" />
        </div>
      </Section>
      <div class="external-tasks-foot">
        <Foot
          save={save}
          dirty={!creating.value && dirtyOf(d, detail)}
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
