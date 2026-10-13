// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A new knowledge file made inside a task's form: a path and the text,
// as the Knowledge tab's New file has them. Create makes the file at
// once through the knowledge route and hands its id to the form, which
// links it. The file is the project's on its own: cancelling the task
// leaves it in Knowledge. It sits inside the task's form, so its
// buttons never submit it and Enter in the path creates the file.

import { useSignal } from "@preact/signals";
import { addFile } from "../../data/knowledge.ts";
import { useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  pathFieldOf,
  pathReady,
  shapePath,
} from "../knowledge/file/DocPage.model.ts";

// the file made through the knowledge route, by its id
export async function makeTaskFile(
  projectId: string,
  path: string,
  text: string,
): Promise<string> {
  return (await addFile(projectId, { name: path.trim(), text })).id;
}

// the form is told a file is being made until it is linked, so the
// task never saves without it
export async function createAndLink(
  make: () => Promise<string>,
  on: {
    creating: (busy: boolean) => void;
    created: (fileId: string) => void;
  },
): Promise<void> {
  on.creating(true);
  try {
    on.created(await make());
  } finally {
    on.creating(false);
  }
}

export function NewTaskFile({
  projectId,
  disabled,
  onCreating,
  onCreated,
  onClose,
}: {
  projectId: string;
  // while the task's form saves
  disabled: boolean;
  onCreating: (busy: boolean) => void;
  onCreated: (fileId: string) => void;
  onClose: () => void;
}) {
  const path = useSignal("");
  const text = useSignal("");
  const save = useSave(async () => {}, pathFieldOf);
  const name = path.value.trim();
  const off = disabled || save.busy;
  const create = async () => {
    if (!pathReady(name) || off) return;
    await save.act("create the file", () =>
      createAndLink(() => makeTaskFile(projectId, name, text.value), {
        creating: onCreating,
        created: onCreated,
      }),
    );
  };
  const invalid = save.fieldError("path") !== null;
  return (
    <fieldset class="external-tasks-new-file" aria-label="New file">
      <label class="field">
        <span class="label label-required">Path</span>
        <input
          name="path"
          placeholder="briefs/the-task.md"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          aria-invalid={invalid || undefined}
          disabled={off}
          value={path.value}
          onInput={(ev) => {
            save.touch();
            path.value = shapePath(ev.currentTarget.value);
          }}
          onKeyDown={(ev) => {
            if (ev.key !== "Enter") return;
            // the task's form would take it as its submit
            ev.preventDefault();
            void create();
          }}
        />
        <FieldError save={save} field="path" />
      </label>
      <label class="field">
        <span class="label">Text</span>
        <textarea
          name="file-text"
          rows={6}
          disabled={off}
          value={text.value}
          onInput={(ev) => {
            save.touch();
            text.value = ev.currentTarget.value;
          }}
        />
      </label>
      <Foot
        save={save}
        before={
          <button type="button" class="btn" disabled={off} onClick={onClose}>
            Cancel
          </button>
        }
      >
        <button
          type="button"
          class="btn btn-primary"
          disabled={off || !pathReady(name)}
          onClick={() => void create()}
        >
          {save.pending.value === "create the file" ? "Creating" : "Create"}
        </button>
      </Foot>
    </fieldset>
  );
}
