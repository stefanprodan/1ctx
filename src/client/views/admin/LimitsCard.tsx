// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Limits tab: a form per scope, each limit typed in the page's unit
// with the default beside a changed one; Save and Reset to defaults at
// each form's foot. A change applies to the next send, a run cap to the
// next admission. A save that would delete asks first, in the foot:
// lowering the days archived chats are kept deletes the older ones at
// the next sweep.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitScope } from "../../../shared/words.ts";
import { saveLimits } from "../../data/tools.ts";
import { type Save, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsCard } from "../../ui/Rows.tsx";
import {
  collect,
  defaultLine,
  defaultsOf,
  deleteAsk,
  dirty,
  displayOf,
  draftOf,
  keepDays,
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
  save,
  onInput,
}: {
  row: LimitRow;
  text: string;
  busy: boolean;
  // a refusal that names this limit is drawn in place of its hint
  save: Pick<Save, "fieldError">;
  onInput: (text: string) => void;
}) {
  const { word } = displayOf(row);
  const words = LIMIT_WORDS[row.name];
  const error = save.fieldError(row.name);
  return (
    <label class="tools-limit">
      <span class="tools-limit-words">
        <span class="tools-limit-label">{words.label}</span>
        {error ? (
          <FieldError save={save} field={row.name} />
        ) : (
          <span class="tools-limit-text">{words.text}</span>
        )}
      </span>
      <span class="tools-limit-field">
        <input
          class={`tools-input${error ? " tools-input-invalid" : ""}`}
          name={row.name}
          aria-invalid={error ? true : undefined}
          type="text"
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
    </label>
  );
}

// one scope's form: the fields seeded from its rows and re-seeded only
// when a save answers new values for them, never when a save of the
// other form moves only their change times, so what is typed here
// stays. The route takes the full set, so a save or a reset sends the
// other scope's latest saved values beside this one's; the save is
// built once, so it reads the rows through a ref.
export function useLimitsForm(rows: LimitRow[], scope: LimitScope) {
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
  const changed = own.some((row) => row.changedAt !== null);
  const type = (name: string, text: string) => {
    draft.value = { ...draft.value, [name]: text };
    save.touch();
  };
  return { own, draft, form, save, submit, reset, changed, type };
}

export function LimitsCard({
  rows,
  scope,
  title,
}: {
  rows: LimitRow[];
  scope: LimitScope;
  title: string;
}) {
  const { own, draft, form, save, submit, reset, changed, type } =
    useLimitsForm(rows, scope);
  const busy = save.busy;
  // the question a save that deletes asks, and the save it holds back,
  // until Delete or Keep; Reset to defaults may lower the days too
  const asking = useSignal<{
    words: string;
    go: () => void;
    keep: () => void;
  } | null>(null);
  const ask = (
    next: Record<string, string>,
    go: () => void,
    keep: () => void = () => {},
  ) => {
    const words = deleteAsk(own, next);
    if (words === null) go();
    else asking.value = { words, go, keep };
  };
  const defaults = draftOf(own.map((row) => ({ ...row, value: row.default })));
  return (
    <RowsCard label={title}>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          // Keep takes back only the lowered days, never other edits
          ask(
            draft.value,
            () => submit(event),
            () => {
              draft.value = keepDays(own, draft.value);
            },
          );
        }}
      >
        <div class="tools-form">
          {own.map((row) => (
            <LimitField
              key={row.name}
              row={row}
              text={draft.value[row.name] ?? ""}
              busy={busy}
              save={save}
              onInput={(text) => type(row.name, text)}
            />
          ))}
        </div>
        <div class="tools-foot">
          <Foot
            save={save}
            dirty={dirty(own, draft.value)}
            label="Save"
            start={
              asking.value !== null ? (
                <>
                  <span class="tools-ask-words">{asking.value.words}</span>
                  <button
                    type="button"
                    class="btn btn-danger"
                    onClick={() => {
                      const { go } = asking.value ?? { go: () => {} };
                      asking.value = null;
                      go();
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => {
                      const { keep } = asking.value ?? { keep: () => {} };
                      asking.value = null;
                      keep();
                      save.touch();
                    }}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  class="btn"
                  disabled={busy || !changed}
                  onClick={() => ask(defaults, () => void reset())}
                >
                  {save.pending.value === "reset the limits"
                    ? "Resetting"
                    : "Reset to defaults"}
                </button>
              )
            }
          >
            {/* while the save asks, its buttons are the only ones */}
            {asking.value !== null ? <span /> : undefined}
          </Foot>
        </div>
      </form>
    </RowsCard>
  );
}
