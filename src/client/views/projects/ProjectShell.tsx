// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's shell backend and image variant: a section on its Settings
// tab and two cards on a team project's admin page, each select written
// at once. An admin picks them on any project; anyone else, a personal
// project's owner included, reads them in the same selects, disabled.

import { type Signal, useSignal } from "@preact/signals";
import type { UpdateProjectRequest } from "../../../shared/api/projects.ts";
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
  pickedVariant,
  SHELL_ADMIN_HINT,
  SHELL_TEXT,
  shellOptions,
  shellValue,
  VARIANT_TEXT,
  variantHint,
  variantOptions,
  variantValue,
} from "./ProjectShell.model.ts";

export function ProjectShell({
  project,
  section,
  edit,
  saving,
}: {
  project: ProjectDetail;
  // a Settings tab's section rather than the admin page's cards
  section: boolean;
  edit: boolean;
  // the admin page's one save at a time, since the answer is the row
  saving?: Signal<boolean>;
}) {
  const picking = useAction();
  // the select last picked, whose refusal is drawn beside it
  const picked = useSignal<"backend" | "variant">("backend");
  const busy = picking.busy.value || saving?.value === true;
  const write = (body: Pick<UpdateProjectRequest, "backend" | "variant">) => {
    picked.value = body.variant === undefined ? "backend" : "variant";
    const save = () => saveShell(project.id, body);
    void picking.run(() =>
      saving === undefined ? save() : holding(saving, save),
    );
  };
  const backend = shellValue(project);
  const variant = variantValue(project);
  const backendSelect = (small: boolean) => (
    <Select
      label="Shell backend"
      name="backend"
      small={small}
      value={backend}
      options={shellOptions(project.instanceBackend)}
      disabled={!edit || busy}
      onChange={(value) => {
        if (value !== backend) write({ backend: pickedBackend(value) });
      }}
    />
  );
  const variantSelect = (small: boolean) => (
    <Select
      label="Image variant"
      name="variant"
      small={small}
      value={variant}
      options={variantOptions(project.instanceVariant)}
      disabled={!edit || busy}
      onChange={(value) => {
        if (value !== variant) write({ variant: pickedVariant(value) });
      }}
    />
  );
  const failure = picking.failure.value;
  const failed = picked.value === "backend" ? failure : null;
  const variantFailed = picked.value === "variant" ? failure : null;
  if (section) {
    return (
      <Section title="Shell" text={SHELL_TEXT}>
        <div class="field">
          <span class="label">Backend</span>
          {backendSelect(false)}
          {failed !== null ? (
            <span class="hint error" role="alert">
              {failed}
            </span>
          ) : (
            !edit && <span class="hint">{SHELL_ADMIN_HINT}</span>
          )}
        </div>
        <div class="field">
          <span class="label">Variant</span>
          {variantSelect(false)}
          {variantFailed !== null ? (
            <span class="hint error" role="alert">
              {variantFailed}
            </span>
          ) : (
            <span class="hint">{variantHint(project)}</span>
          )}
        </div>
      </Section>
    );
  }
  return (
    <>
      <Setting
        title="Shell"
        line={
          failed !== null ? <span class="error">{failed}</span> : SHELL_TEXT
        }
        action={<span class="project-shell-pick">{backendSelect(true)}</span>}
      />
      <Setting
        title="Shell variant"
        line={
          variantFailed !== null ? (
            <span class="error">{variantFailed}</span>
          ) : (
            `${VARIANT_TEXT} ${variantHint(project)}`
          )
        }
        action={<span class="project-shell-pick">{variantSelect(true)}</span>}
      />
    </>
  );
}
