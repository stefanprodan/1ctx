// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's Needs attention step, drawn as Memory's: who marks
// a run, and when a mode is on, the automation's own words on when,
// which its agent and the decider read.

import { deciderOn } from "../../data/automations.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Section } from "../../ui/Section.tsx";
import { Seg } from "../../ui/Seg.tsx";
import {
  attentionHint,
  attentionOptions,
  guidanceShown,
} from "./Attention.model.ts";
import type { Draft } from "./Automations.model.ts";

export function AttentionSection({
  draft,
  set,
  save,
  takesTools,
  disabled,
}: {
  draft: Pick<Draft, "attention" | "attentionGuidance">;
  set: (patch: Pick<Partial<Draft>, "attention" | "attentionGuidance">) => void;
  save: Pick<Save, "fieldError">;
  takesTools: boolean;
  disabled: boolean;
}) {
  const on = deciderOn.value;
  const hint = attentionHint({ takesTools, deciderOn: on });
  const invalid = (field: string) => save.fieldError(field) !== null;
  return (
    <Section title="Needs attention" text="Who decides a run must be flagged">
      <div class="field">
        <Seg
          label="Needs attention"
          invalid={invalid("attention")}
          name="attention"
          options={attentionOptions({
            takesTools,
            deciderOn: on,
            off: disabled,
          })}
          value={draft.attention}
          onPick={(attention) => set({ attention })}
        />
        {hint !== null && !invalid("attention") && (
          <span class="hint">{hint}</span>
        )}
        <FieldError save={save} field="attention" />
        {/* a refusal of the text keeps it in sight */}
        {(guidanceShown({ mode: draft.attention, takesTools }) ||
          invalid("attentionGuidance")) && (
          <label class="field automations-guidance">
            <textarea
              name="attentionGuidance"
              aria-label="When it needs attention"
              rows={3}
              placeholder="When it needs attention"
              aria-invalid={invalid("attentionGuidance") || undefined}
              disabled={disabled}
              value={draft.attentionGuidance}
              onInput={(e) =>
                set({
                  attentionGuidance: (e.currentTarget as HTMLTextAreaElement)
                    .value,
                })
              }
            />
            <FieldError save={save} field="attentionGuidance" />
          </label>
        )}
      </div>
    </Section>
  );
}
