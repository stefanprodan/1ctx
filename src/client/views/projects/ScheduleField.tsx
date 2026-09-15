// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The editor's When: a shape picked from every few minutes to monthly,
// or cron typed by hand, the fields that shape needs, the time zone,
// and the server's reading of the result: the next run, or its
// refusal. The expression is always on show, so the
// shapes teach cron rather than hide it.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { MAX_SCHEDULE } from "../../../shared/words.ts";
import { loadPreview, preview, previewKey } from "../../data/automations.ts";
import { until } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Select } from "../../ui/Select.tsx";
import { ZoneSelect } from "../../ui/ZoneSelect.tsx";
import { scheduleTitle } from "./Automations.model.ts";
import {
  type Builder,
  builderOf,
  EVERY,
  EVERY_LABELS,
  expressionOf,
  fireLabel,
  STEPS,
  switchEvery,
  WEEK,
} from "./Schedule.model.ts";

// the preview waits for the typing to pause
const PREVIEW_WAIT_MS = 300;

export function ScheduleField({
  projectId,
  schedule,
  tz,
  disabled,
  onSchedule,
  onTz,
}: {
  projectId: string;
  schedule: string;
  tz: string;
  disabled: boolean;
  onSchedule: (expression: string) => void;
  onTz: (tz: string) => void;
}) {
  // the shape is read once from the row; after that the fields are the
  // truth and the expression follows them
  const builder = useSignal<Builder>(builderOf(schedule));
  const set = (next: Builder) => {
    builder.value = next;
    onSchedule(expressionOf(next));
  };
  const b = builder.value;
  const expression = expressionOf(b);
  // the first reading is asked at once, so the page opens with it
  const asked = useRef(false);
  useEffect(() => {
    if (expression === "" || tz === "") return;
    const wait = asked.current ? PREVIEW_WAIT_MS : 0;
    asked.current = true;
    const timer = setTimeout(
      () => void loadPreview(projectId, expression, tz),
      wait,
    );
    return () => clearTimeout(timer);
  }, [projectId, expression, tz]);
  const held =
    preview.value?.key === previewKey(projectId, expression, tz)
      ? preview.value
      : null;
  const now = Date.now();
  // the last fires stay on the strip while the next reading is asked,
  // so it does not blink at every keystroke; a refusal clears them
  const last = useRef<number[] | null>(null);
  if (held?.fires) last.current = held.fires;
  if (held?.problem || expression === "") last.current = null;
  const fires = held?.fires ?? last.current;
  const time = (
    <label class="field automations-time">
      <span class="label">At</span>
      <input
        type="time"
        name="time"
        disabled={disabled}
        value={b.time}
        onInput={(e) =>
          set({ ...b, time: (e.currentTarget as HTMLInputElement).value })
        }
      />
    </label>
  );
  return (
    <div class="automations-schedule">
      <fieldset class="automations-every" aria-label="Repeats">
        {EVERY.map((every) => (
          <button
            key={every}
            type="button"
            class={`automations-every-option${
              b.every === every ? " automations-every-on" : ""
            }`}
            aria-pressed={b.every === every}
            disabled={disabled}
            onClick={() => set(switchEvery(b, every))}
          >
            {EVERY_LABELS[every]}
          </button>
        ))}
      </fieldset>
      <div class="automations-when">
        {b.every === "minutes" && (
          <div class="field automations-step">
            <span class="label">Every</span>
            <Select
              label="Every"
              value={String(b.step)}
              options={STEPS.map((n) => ({
                value: String(n),
                label: `${n} minutes`,
              }))}
              disabled={disabled}
              onChange={(n) => set({ ...b, step: Number(n) })}
            />
          </div>
        )}
        {b.every === "hourly" && (
          <label class="field automations-number">
            <span class="label">Minute</span>
            <input
              name="minute"
              type="number"
              min={0}
              max={59}
              disabled={disabled}
              value={b.minute}
              onInput={(e) => {
                const n = Number((e.currentTarget as HTMLInputElement).value);
                if (Number.isInteger(n) && n >= 0 && n <= 59) {
                  set({ ...b, minute: n });
                }
              }}
            />
          </label>
        )}
        {b.every === "weekly" && (
          <div class="field">
            <span class="label">On</span>
            <fieldset class="automations-days" aria-label="Days">
              {WEEK.map((day) => {
                const on = b.days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    class={`automations-day${on ? " automations-day-on" : ""}`}
                    aria-pressed={on}
                    aria-label={day.name}
                    title={day.name}
                    disabled={disabled}
                    onClick={() =>
                      set({
                        ...b,
                        days: on
                          ? b.days.filter((d) => d !== day.value)
                          : [...b.days, day.value],
                      })
                    }
                  >
                    {day.short}
                  </button>
                );
              })}
            </fieldset>
          </div>
        )}
        {b.every === "monthly" && (
          <label class="field automations-number">
            <span class="label">Day</span>
            <input
              name="day"
              type="number"
              min={1}
              max={31}
              disabled={disabled}
              value={b.dayOfMonth}
              onInput={(e) => {
                const n = Number((e.currentTarget as HTMLInputElement).value);
                if (Number.isInteger(n) && n >= 1 && n <= 31) {
                  set({ ...b, dayOfMonth: n });
                }
              }}
            />
          </label>
        )}
        {(b.every === "daily" ||
          b.every === "weekly" ||
          b.every === "monthly") &&
          time}
        {b.every === "cron" && (
          <label class="field automations-cron">
            <span class="label">Expression</span>
            <input
              name="schedule"
              class="automations-mono"
              autocomplete="off"
              spellcheck={false}
              maxLength={MAX_SCHEDULE}
              placeholder="0 9 * * 1-5"
              disabled={disabled}
              value={b.cron}
              onInput={(e) =>
                set({ ...b, cron: (e.currentTarget as HTMLInputElement).value })
              }
            />
          </label>
        )}
        <div class="field automations-zone">
          <span class="label">Time zone</span>
          <ZoneSelect value={tz} disabled={disabled} onChange={onTz} />
        </div>
      </div>
      <div class="automations-readback" aria-live="polite">
        <div class="automations-readback-head">
          <span class="automations-words">
            <Icon name="clock" size={14} />
            {expression === ""
              ? b.every === "weekly" && b.days.length === 0
                ? "Pick a day"
                : "Pick a time"
              : scheduleTitle(expression)}
          </span>
          {b.every !== "cron" && expression !== "" && (
            <code class="automations-mono automations-faint">{expression}</code>
          )}
        </div>
        {expression !== "" && held?.problem ? (
          <span class="automations-bad">{held.problem}</span>
        ) : fires !== null && fires.length > 0 ? (
          <span class="automations-next">
            <Icon name="arrow-right" size={14} />
            Next run {fireLabel(fires[0], now, tz, true)},{" "}
            {until(fires[0], now)}
          </span>
        ) : (
          // holds the line's room while the reading is on its way, so
          // the panel does not grow when it lands
          <span class="automations-next" aria-hidden="true">
            &nbsp;
          </span>
        )}
      </div>
    </div>
  );
}
