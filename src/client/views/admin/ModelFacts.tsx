// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the agent form asks for a model its catalog does not describe:
// the context window in tokens and whether it takes tools. The runner
// compacts and weighs the window by the first, and offers tools by the
// second, as it would by the catalog's words.

import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import type { Choice } from "./Agents.model.ts";
import { Picks } from "./Picks.tsx";

const TOOLS_CHOICES: Choice<"on" | "off">[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

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
      <label class="field">
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
        <Picks
          choices={TOOLS_CHOICES}
          value={tools ? "on" : "off"}
          busy={busy}
          onPick={(value) => onTools(value === "on")}
        />
      </div>
    </>
  );
}
