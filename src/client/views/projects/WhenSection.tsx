// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The automation editor's When step: the schedule, then the check URL a
// scheduled run asks first, empty for none, and with a URL the JSON
// value it compares.

import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Section } from "../../ui/Section.tsx";
import type { Draft } from "./Automations.model.ts";
import { ScheduleField } from "./ScheduleField.tsx";

export const CHECK_HINT =
  "Asked at every scheduled time. Runs only when the answer is new.";
export const COMPARE_HINT =
  "Only a change in this JSON value starts a run. Empty compares the whole answer.";

export function WhenSection({
  projectId,
  draft: d,
  set,
  save,
  disabled,
}: {
  projectId: string;
  draft: Pick<Draft, "schedule" | "tz" | "once" | "checkUrl" | "checkCompare">;
  set: (patch: Partial<Draft>) => void;
  save: Pick<Save, "fieldError">;
  disabled: boolean;
}) {
  const invalid = (field: string) => save.fieldError(field) !== null;
  return (
    <Section title="When" text="In the time zone you pick">
      <div class="automations-when-fields">
        <ScheduleField
          projectId={projectId}
          schedule={d.schedule}
          tz={d.tz}
          disabled={disabled}
          invalidTz={invalid("tz")}
          once={d.once}
          onOnce={() => set({ once: !d.once })}
          onSchedule={(schedule) => set({ schedule })}
          onTz={(tz) => set({ tz })}
        />
        <FieldError save={save} field="schedule" />
        <FieldError save={save} field="tz" />
        <label class="field">
          <span class="label">Check URL</span>
          <input
            name="checkUrl"
            inputMode="url"
            class="automations-mono"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://"
            aria-invalid={invalid("checkUrl") || undefined}
            disabled={disabled}
            value={d.checkUrl}
            onInput={(e) =>
              set({ checkUrl: (e.currentTarget as HTMLInputElement).value })
            }
          />
          {invalid("checkUrl") ? (
            <FieldError save={save} field="checkUrl" />
          ) : (
            <span class="hint">{CHECK_HINT}</span>
          )}
        </label>
        {d.checkUrl.trim() !== "" && (
          <label class="field">
            <span class="label">Compare</span>
            <input
              name="checkCompare"
              class="automations-mono"
              autocomplete="off"
              spellcheck={false}
              placeholder="tag_name"
              aria-invalid={invalid("checkCompare") || undefined}
              disabled={disabled}
              value={d.checkCompare}
              onInput={(e) =>
                set({
                  checkCompare: (e.currentTarget as HTMLInputElement).value,
                })
              }
            />
            {invalid("checkCompare") ? (
              <FieldError save={save} field="checkCompare" />
            ) : (
              <span class="hint">{COMPARE_HINT}</span>
            )}
          </label>
        )}
      </div>
    </Section>
  );
}
