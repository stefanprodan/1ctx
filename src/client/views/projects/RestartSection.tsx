// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's After a restart step: one switch, drawn as the
// Access step's rows, to start again a run a deploy stopped.

import { Icon } from "../../lib/icons.tsx";
import {
  RowsAvatar,
  RowsLine,
  RowsList,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import type { Draft } from "./Automations.model.ts";

const AGAIN = "Restart the run";

export function RestartSection({
  on,
  set,
  disabled,
}: {
  on: boolean;
  set: (patch: Pick<Draft, "rerunOnRestart">) => void;
  disabled: boolean;
}) {
  return (
    <Section title="After a restart" text="A deploy can stop a run">
      <div class="field">
        <RowsList>
          <RowsLine flush>
            <RowsAvatar>
              <Icon name="redo" size={14} />
            </RowsAvatar>
            <RowsTitle name={AGAIN} />
            <RowsSwitch
              on={on}
              label={AGAIN}
              disabled={disabled}
              onClick={() => set({ rerunOnRestart: !on })}
            />
          </RowsLine>
        </RowsList>
        <span class="hint">Starts over from the beginning.</span>
      </div>
    </Section>
  );
}
