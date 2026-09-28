// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New project, the Projects list's `?new`: the name and the description,
// both required, with one Create, as New user. Create opens the
// project's page, where its members are added.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  adminProjects,
  adminProjectsError,
  createProject,
} from "../../data/admin-projects.ts";
import { adminProjectHref, PROJECTS_HREF } from "../../lib/hrefs.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { touch } from "../../lib/touch.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import { DescriptionField, NameField } from "../projects/ProjectFields.tsx";
import {
  DESCRIPTION_PLACEHOLDER,
  descriptionProblem,
  nameTaken,
  projectFieldOf,
} from "./AdminProjects.model.ts";
import "./admin-projects.css";

const STEPS = [zoneStep("Access"), { label: "Projects", href: PROJECTS_HREF }];

export function NewProject() {
  const error = adminProjectsError.value;
  return (
    <Page
      steps={STEPS}
      title="New project"
      loading={adminProjects.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const name = useSignal("");
  const description = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  // with a mouse the name takes the caret on arrival
  useEffect(() => {
    if (!touch()) {
      form.current?.querySelector<HTMLInputElement>('[name="name"]')?.focus();
    }
  }, []);
  const save = useSave(async () => {
    const from = address();
    const created = await createProject({
      name: name.value.trim(),
      description: description.value.trim(),
    });
    if (address() === from) navigate(adminProjectHref(created.id));
  }, projectFieldOf);
  useFocusField(save, form);
  const trimmed = name.value.trim();
  const taken = nameTaken(adminProjects.value ?? [], trimmed);
  return (
    <form
      class="admin-projects-page"
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("name", nameProblem(name.value)) ??
            at("description", descriptionProblem(description.value)),
        );
      }}
    >
      <Setting
        label="New project"
        foot={
          <Foot
            save={save}
            dirty={trimmed !== "" && !taken}
            label="Create project"
            stack={taken}
            // the hint's place holds the buttons at the right
            start={
              <SettingHint>
                {taken && <span class="error">{trimmed} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href={PROJECTS_HREF}>
                Cancel
              </a>
            }
          />
        }
      >
        <div class="pair">
          <NameField
            disabled={save.busy}
            error={save.fieldError("name")}
            value={name.value}
            onInput={(value) => {
              name.value = value;
              save.touch();
            }}
          />
          <DescriptionField
            class="pair-wide"
            required
            placeholder={DESCRIPTION_PLACEHOLDER}
            disabled={save.busy}
            error={save.fieldError("description")}
            value={description.value}
            onInput={(value) => {
              description.value = value;
              save.touch();
            }}
          />
        </div>
      </Setting>
    </form>
  );
}
