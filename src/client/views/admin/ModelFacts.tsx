// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { Seg } from "../../ui/Seg.tsx";

const TOOLS_CHOICES = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function ModelFacts({
  save,
  window,
  tools,
  suggested = false,
  busy,
  onWindow,
  onTools,
}: {
  save: Pick<Save, "fieldError">;
  window: string;
  tools: boolean;
  // the window is models.dev's, not yet changed
  suggested?: boolean;
  busy: boolean;
  onWindow: (value: string) => void;
  onTools: (value: boolean) => void;
}) {
  const invalid = save.fieldError("contextLength") !== null;
  return (
    <>
      <label class="field agent-page-window">
        <span class="label">Context window</span>
        <NumberBox
          name="contextLength"
          unit="K"
          placeholder="128"
          invalid={invalid}
          disabled={busy}
          value={window}
          onInput={onWindow}
        />
        {invalid ? (
          <FieldError save={save} field="contextLength" />
        ) : (
          <span class="hint">
            {suggested
              ? "Thousands of tokens. Suggested by models.dev."
              : "Thousands of tokens. The catalog does not list this model's window."}
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
