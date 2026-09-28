// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings card of limits: its limits side by side, each with its
// default beside a changed one and its line under the box; Use defaults
// puts the defaults in the boxes, and only Save sends them. A save that
// lowers the days archived chats are kept deletes the older ones at the
// next sweep, so it asks first, in the foot.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitName } from "../../../shared/words.ts";
import { saveLimits } from "../../data/tools.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import {
  collect,
  defaultLine,
  deleteAsk,
  displayOf,
  draftOf,
  keepDays,
  LIMIT_WORDS,
  limitFieldOf,
  dirty as limitsDirty,
  seedOf,
  show,
} from "./Tools.model.ts";
import "./limits-setting.css";

// one form over some limits: the fields seeded from their rows and
// re-seeded only when a save answers new values for them, never when a
// save of another form moves only their change times, so what is typed
// here stays. A save sends these limits alone; the save is built once,
// so it reads the rows through a ref.
function useLimitsForm(rows: LimitRow[], names: readonly LimitName[]) {
  // in the order the names are given, so a card lays its fields out
  const mine = (list: LimitRow[]) =>
    names.flatMap((name) => list.filter((row) => row.name === name));
  const own = mine(rows);
  const latest = useRef(rows);
  latest.current = rows;
  const draft = useSignal(draftOf(own));
  // the question a save that deletes asks, until Delete or Keep; a
  // re-seed drops it, since it was asked of the draft it replaces
  const asking = useSignal<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const seed = seedOf(own);
  useEffect(() => {
    draft.value = draftOf(own);
    asking.value = null;
  }, [seed]);
  const save = useSave(async () => {
    const got = collect(mine(latest.current), draft.value);
    if ("problem" in got) throw new Error(got.problem);
    await saveLimits({ values: got.values });
  }, limitFieldOf);
  useFocusField(save, form);
  const run = () => {
    const got = collect(own, draft.value);
    void save.run(
      "problem" in got ? { error: got.problem, field: got.field } : null,
    );
  };
  const type = (name: string, text: string) => {
    draft.value = { ...draft.value, [name]: text };
    save.touch();
  };
  const defaults = () => {
    draft.value = draftOf(own.map((row) => ({ ...row, value: row.default })));
    save.touch();
  };
  const discard = () => {
    draft.value = draftOf(own);
  };
  return { own, draft, asking, form, save, run, type, defaults, discard };
}

export function LimitsSetting({
  rows,
  names,
  title = "Limits",
  line,
}: {
  rows: LimitRow[];
  names: readonly LimitName[];
  title?: string;
  line: string;
}) {
  const { own, draft, asking, form, save, run, type, defaults, discard } =
    useLimitsForm(rows, names);
  const atDefaults = own.every(
    (row) => draft.value[row.name] === show(row, row.default),
  );
  const dirty = limitsDirty(own, draft.value);
  return (
    <form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        const words = deleteAsk(own, draft.value);
        if (words === null) run();
        else {
          // a failed save's words would stand in the ask's place
          save.touch();
          asking.value = words;
        }
      }}
    >
      <Setting
        title={title}
        line={line}
        action={
          <button
            type="button"
            class="btn btn-small"
            disabled={save.busy || atDefaults || asking.value !== null}
            onClick={defaults}
          >
            Use defaults
          </button>
        }
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
            blocked={asking.value !== null}
            hint={
              asking.value === null ? undefined : (
                <span class="limits-setting-ask">
                  {asking.value}
                  <button
                    type="button"
                    class="btn btn-small btn-danger"
                    onClick={() => {
                      asking.value = null;
                      run();
                    }}
                  >
                    Delete
                  </button>
                  {/* Keep takes back only the lowered days */}
                  <button
                    type="button"
                    class="btn btn-small"
                    onClick={() => {
                      asking.value = null;
                      draft.value = keepDays(own, draft.value);
                      save.touch();
                    }}
                  >
                    Keep
                  </button>
                </span>
              )
            }
            onDiscard={() => {
              asking.value = null;
              discard();
            }}
          />
        }
      >
        <div class="limits-setting-grid">
          {own.map((row) => {
            const words = LIMIT_WORDS[row.name];
            const error = save.fieldError(row.name);
            return (
              <label key={row.name} class="field">
                <span class="limits-setting-label">
                  <span class="label">{words.label}</span>
                  {row.changedAt !== null && (
                    <span class="hint">{defaultLine(row)}</span>
                  )}
                </span>
                <NumberBox
                  name={row.name}
                  value={draft.value[row.name] ?? ""}
                  unit={displayOf(row).word}
                  invalid={error !== null}
                  disabled={save.busy}
                  onInput={(text) => {
                    asking.value = null;
                    type(row.name, text);
                  }}
                />
                {error !== null ? (
                  <FieldError save={save} field={row.name} />
                ) : (
                  <span class="hint">{words.text}</span>
                )}
              </label>
            );
          })}
        </div>
      </Setting>
    </form>
  );
}
