// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add file: the name the file takes in the base and the text it holds.
// Every check is Knowledge.model.ts, so a refusal lands at the field it
// is about and the server is asked only for what it alone knows.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { addFile } from "../../data/knowledge.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  fieldOf,
  NAME_HINT,
  nameProblem,
  textProblem,
} from "./Knowledge.model.ts";
import "./knowledge.css";

export function KnowledgeForm({
  projectId,
  names,
  onDone,
}: {
  projectId: string;
  // the live names, for the rule that no file is another file's directory
  names: readonly string[];
  onDone: () => void;
}) {
  const name = useSignal("");
  const text = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await addFile(projectId, { name: name.value.trim(), text: text.value });
    onDone();
  }, fieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value, names)) ??
        at("text", textProblem(text.value)),
    );
  };
  return (
    <form class="knowledge-form" ref={form} onSubmit={submit}>
      <label class="field">
        <span class="label label-required">Name</span>
        <input
          name="name"
          aria-required="true"
          autocomplete="off"
          spellcheck={false}
          placeholder="docs/runbook.md"
          aria-invalid={invalid("name") || undefined}
          disabled={busy}
          value={name.value}
          onInput={(e) => {
            name.value = e.currentTarget.value;
            save.touch();
          }}
        />
        {invalid("name") ? (
          <FieldError save={save} field="name" />
        ) : (
          <span class="hint">{NAME_HINT}</span>
        )}
      </label>
      <label class="field">
        <span class="label label-required">Text</span>
        <textarea
          name="text"
          aria-required="true"
          class="knowledge-area"
          spellcheck={false}
          rows={8}
          aria-invalid={invalid("text") || undefined}
          disabled={busy}
          value={text.value}
          onInput={(e) => {
            text.value = e.currentTarget.value;
            save.touch();
          }}
        />
        {invalid("text") ? (
          <FieldError save={save} field="text" />
        ) : (
          <span class="hint">Any UTF-8 text</span>
        )}
      </label>
      <Foot
        save={save}
        dirty
        label="Add"
        before={
          <button
            type="button"
            class="btn btn-small"
            disabled={busy}
            onClick={onDone}
          >
            Cancel
          </button>
        }
      />
    </form>
  );
}
