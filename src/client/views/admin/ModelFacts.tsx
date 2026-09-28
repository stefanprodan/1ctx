// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Seg } from "../../ui/Seg.tsx";

const TOOLS_CHOICES = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function ModelFacts({
  save,
  window,
  tools,
  busy,
  onWindow,
  onTools,
}: {
  save: Pick<Save, "fieldError">;
  window: string;
  tools: boolean;
  busy: boolean;
  onWindow: (value: string) => void;
  onTools: (value: boolean) => void;
}) {
  const invalid = save.fieldError("contextLength") !== null;
  return (
    <>
      <label class="field agent-page-window">
        <span class="label">Context window</span>
        <input
          name="contextLength"
          inputMode="numeric"
          autocomplete="off"
          spellcheck={false}
          placeholder="131072"
          aria-invalid={invalid || undefined}
          disabled={busy}
          value={window}
          onInput={(e) => onWindow((e.currentTarget as HTMLInputElement).value)}
        />
        {invalid ? (
          <FieldError save={save} field="contextLength" />
        ) : (
          <span class="hint">
            Tokens. The catalog does not list this model's window.
          </span>
        )}
      </label>
      <div class="field">
        <span class="label">Tools</span>
        <Seg
          label="Tools"
          options={TOOLS_CHOICES.map((c) => ({ ...c, disabled: busy }))}
          value={tools ? "on" : "off"}
          onPick={(value) => onTools(value === "on")}
        />
      </div>
    </>
  );
}
