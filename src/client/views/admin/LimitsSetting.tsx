// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings page's Limits card: its limits side by side, each with its
// default beside a changed one and its line under the box; Use defaults
// puts the defaults in the boxes, and only Save sends them.

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitName } from "../../../shared/words.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLimitsForm } from "./LimitsCard.tsx";
import {
  defaultLine,
  displayOf,
  LIMIT_WORDS,
  dirty as limitsDirty,
  show,
} from "./Tools.model.ts";
import "./limits-setting.css";

export function LimitsSetting({
  rows,
  names,
  line,
}: {
  rows: LimitRow[];
  names: readonly LimitName[];
  line: string;
}) {
  const { own, draft, form, save, submit, type, defaults, discard } =
    useLimitsForm(rows, names);
  const atDefaults = own.every(
    (row) => draft.value[row.name] === show(row, row.default),
  );
  return (
    <form ref={form} onSubmit={submit}>
      <Setting
        title="Limits"
        line={line}
        action={
          <button
            type="button"
            class="btn btn-small"
            disabled={save.busy || atDefaults}
            onClick={defaults}
          >
            Use defaults
          </button>
        }
        foot={
          <DraftFoot
            save={save}
            dirty={limitsDirty(own, draft.value)}
            onDiscard={discard}
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
                  onInput={(text) => type(row.name, text)}
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
