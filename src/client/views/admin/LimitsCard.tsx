// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Limits tab: a form per send and a form per call, each limit typed
// in the page's unit with the default beside a changed one; Save and
// Reset to defaults at each form's foot. A change applies to the next send.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitScope } from "../../../shared/words.ts";
import { saveLimits } from "../../data/tools.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { RowsCard } from "../../ui/Rows.tsx";
import {
  collect,
  defaultLine,
  defaultsOf,
  dirty,
  displayOf,
  draftOf,
  LIMIT_WORDS,
  limitFieldOf,
  seedOf,
  withSaved,
} from "./Tools.model.ts";
import "./tools.css";

function LimitField({
  row,
  text,
  busy,
  error,
  onInput,
}: {
  row: LimitRow;
  text: string;
  busy: boolean;
  // a refusal that names this limit
  error: string | null;
  onInput: (text: string) => void;
}) {
  const { word } = displayOf(row);
  const words = LIMIT_WORDS[row.name];
  return (
    <label class="tools-limit">
      <span class="tools-limit-words">
        <span class="tools-limit-label">{words.label}</span>
        <span class="tools-limit-text">{words.text}</span>
      </span>
      <span class="tools-limit-field">
        <input
          class={`tools-input${error ? " tools-input-invalid" : ""}`}
          name={row.name}
          aria-invalid={error ? true : undefined}
          type="number"
          step="any"
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          value={text}
          onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="tools-unit">{word}</span>
      </span>
      {row.changedAt !== null && (
        <span class="tools-default">{defaultLine(row)}</span>
      )}
      {error && (
        <span class="field-error tools-limit-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

// one scope's form: the fields seeded from its rows and re-seeded only
// when a save answers new values for them, never when a save of the
// other form moves only their change times, so what is typed here
// stays. The route takes the full set, so a save or a reset sends the
// other scope's latest saved values beside this one's; the save is
// built once, so it reads the rows through a ref.
export function LimitsCard({
  rows,
  scope,
  title,
}: {
  rows: LimitRow[];
  scope: LimitScope;
  title: string;
}) {
  const own = rows.filter((row) => row.scope === scope);
  const latest = useRef(rows);
  latest.current = rows;
  const ownNow = () => latest.current.filter((row) => row.scope === scope);
  const draft = useSignal(draftOf(own));
  const form = useRef<HTMLFormElement>(null);
  const seed = seedOf(own);
  useEffect(() => {
    draft.value = draftOf(own);
  }, [seed]);
  const save = useSave(async () => {
    const got = collect(ownNow(), draft.value);
    if ("problem" in got) throw new Error(got.problem);
    await saveLimits({ values: withSaved(latest.current, scope, got.values) });
  }, limitFieldOf);
  useFocusField(save, form);
  const submit = (event: Event) => {
    event.preventDefault();
    const got = collect(own, draft.value);
    void save.run(
      "problem" in got ? { error: got.problem, field: got.field } : null,
    );
  };
  const reset = () =>
    save.act("reset the limits", () =>
      saveLimits({
        values: withSaved(latest.current, scope, defaultsOf(ownNow())),
      }),
    );
  const busy = save.busy;
  const changed = own.some((row) => row.changedAt !== null);
  return (
    <RowsCard label={title}>
      <form ref={form} onSubmit={submit}>
        <div class="tools-form">
          {own.map((row) => (
            <LimitField
              key={row.name}
              row={row}
              text={draft.value[row.name] ?? ""}
              busy={busy}
              error={save.fieldError(row.name)}
              onInput={(text) => {
                draft.value = { ...draft.value, [row.name]: text };
                save.touch();
              }}
            />
          ))}
        </div>
        <div class="tools-foot">
          <Foot
            save={save}
            dirty={dirty(own, draft.value)}
            label="Save"
            start={
              <button
                type="button"
                class="btn"
                disabled={busy || !changed}
                onClick={() => void reset()}
              >
                {save.pending.value === "reset the limits"
                  ? "Resetting"
                  : "Reset to defaults"}
              </button>
            }
          />
        </div>
      </form>
    </RowsCard>
  );
}
