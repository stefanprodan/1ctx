// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add file: the name the file takes in the base, a file dropped or
// picked, and the text itself, which a paste fills as well. Every check
// is Knowledge.model.ts, so a refusal lands at the field it is about
// and the server is asked only for what it alone knows.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { KnowledgeLimits } from "../../../shared/contracts/knowledge.ts";
import { addFile } from "../../data/knowledge.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  baseName,
  bodyProblem,
  fieldOf,
  NAME_HINT,
  nameProblem,
  shapeKnowledgeName,
  textHint,
  textProblem,
} from "./Knowledge.model.ts";
import "./knowledge.css";

export function KnowledgeForm({
  projectId,
  names,
  limits,
  onDone,
}: {
  projectId: string;
  // the live names, for the rule that no file is another file's directory
  names: readonly string[];
  limits: KnowledgeLimits;
  onDone: () => void;
}) {
  const name = useSignal("");
  const text = useSignal("");
  const over = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await addFile(projectId, { name: name.value, text: text.value });
    onDone();
  }, fieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  // a picked or dropped file fills the text, and the name when it is
  // still empty; the browser has decoded it already, so what it could
  // not read arrives as U+FFFD and the text check catches it
  const take = async (picked: File) => {
    const content = await picked.text();
    if (name.value === "") {
      name.value = shapeKnowledgeName(baseName(picked.name));
    }
    text.value = content;
    save.touch();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    const body = { name: name.value, text: text.value };
    void save.run(
      at("name", nameProblem(name.value, names)) ??
        at(
          "text",
          textProblem(text.value, limits.fileBytes) ??
            bodyProblem(body, limits.fileBytes),
        ),
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
            name.value = shapeKnowledgeName(e.currentTarget.value);
            save.touch();
          }}
        />
        {invalid("name") ? (
          <FieldError save={save} field="name" />
        ) : (
          <span class="hint">{NAME_HINT}</span>
        )}
      </label>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop is a
          pointer gesture with no keyboard form; Choose file inside it is
          the way everyone else picks a file */}
      <div
        class={`knowledge-drop${over.value ? " knowledge-drop-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          over.value = true;
        }}
        onDragLeave={() => {
          over.value = false;
        }}
        onDrop={(e) => {
          e.preventDefault();
          over.value = false;
          const picked = e.dataTransfer?.files[0];
          if (picked !== undefined) void take(picked);
        }}
      >
        <span class="knowledge-drop-words">Drop a text file here, or</span>
        <label class="btn btn-small knowledge-choose">
          Choose file
          <input
            class="knowledge-file"
            type="file"
            disabled={busy}
            onChange={(e) => {
              const picked = e.currentTarget.files?.[0];
              if (picked !== undefined) void take(picked);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </div>
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
          <span class="hint">{textHint(limits.fileBytes)}</span>
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
