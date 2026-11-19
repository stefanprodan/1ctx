// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's shell backend: a section on its Settings tab and a card on
// a team project's admin page, one select written at once. A personal
// project's owner and an admin on a team project pick it; a team's
// member reads it in the same select, disabled.

import type { Signal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { saveShell } from "../../data/projects.ts";
import { useAction } from "../../lib/save.ts";
import { Section } from "../../ui/Section.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { holding } from "../admin/drafts.ts";
import "./project-shell.css";
import {
  pickedBackend,
  SHELL_ADMIN_HINT,
  SHELL_TEXT,
  shellOptions,
  shellValue,
} from "./ProjectShell.model.ts";

export function ProjectShell({
  project,
  section,
  edit,
  saving,
}: {
  project: ProjectDetail;
  // a Settings tab's section rather than the admin page's card
  section: boolean;
  edit: boolean;
  // the admin page's one save at a time, since the answer is the row
  saving?: Signal<boolean>;
}) {
  const picking = useAction();
  const current = shellValue(project);
  const busy = picking.busy.value || saving?.value === true;
  const pick = (value: string) => {
    if (value === current) return;
    const backend = pickedBackend(value);
    const write = () => saveShell(project, backend);
    void picking.run(() =>
      saving === undefined ? write() : holding(saving, write),
    );
  };
  const select = (small: boolean) => (
    <Select
      label="Shell backend"
      name="backend"
      small={small}
      value={current}
      options={shellOptions(project.instanceBackend)}
      disabled={!edit || busy}
      onChange={pick}
    />
  );
  const failed = picking.failure.value;
  if (section) {
    return (
      <Section title="Shell" text={SHELL_TEXT}>
        <div class="field">
          <span class="label">Backend</span>
          {select(false)}
          {failed !== null ? (
            <span class="hint error" role="alert">
              {failed}
            </span>
          ) : (
            !edit && <span class="hint">{SHELL_ADMIN_HINT}</span>
          )}
        </div>
      </Section>
    );
  }
  return (
    <Setting
      title="Shell"
      line={failed !== null ? <span class="error">{failed}</span> : SHELL_TEXT}
      action={<span class="project-shell-pick">{select(true)}</span>}
    />
  );
}
