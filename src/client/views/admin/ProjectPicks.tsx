// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { toggledId } from "../../lib/ids.ts";
import type { Save } from "../../lib/save.ts";
import { Finder } from "../../ui/Finder.tsx";
import { RowsEnd, RowsLine, RowsRemove, RowsTitle } from "../../ui/Rows.tsx";

export function ProjectRows({
  teams,
  value,
  save,
  onChange,
}: {
  teams: { id: string; name: string }[];
  value: string[];
  save: Save;
  onChange: (projectIds: string[]) => void;
}) {
  return (
    <>
      {teams
        .filter((p) => value.includes(p.id))
        .map((p) => (
          <RowsLine key={p.id} flush>
            <RowsTitle name={p.name} mono />
            <RowsEnd>
              <RowsRemove
                name={p.name}
                disabled={save.busy}
                onRemove={() => onChange(toggledId(value, p.id))}
              />
            </RowsEnd>
          </RowsLine>
        ))}
    </>
  );
}

export function AddProject({
  teams,
  value,
  disabled,
  onChange,
}: {
  teams: { id: string; name: string }[];
  value: string[];
  disabled: boolean;
  onChange: (projectIds: string[]) => void;
}) {
  return (
    <Finder
      label="Projects"
      add="Add project"
      disabled={disabled}
      options={teams
        .filter((p) => !value.includes(p.id))
        .map((p) => ({ value: p.id, label: p.name }))}
      mono
      placeholder="Find a project"
      none="No project matches"
      empty="Every team project is added"
      onPick={(id) => onChange(toggledId(value, id))}
    />
  );
}
