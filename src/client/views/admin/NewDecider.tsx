// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New decider: the name and the model in one card with one Create, as
// New agent. The search opens on the default decider's provider, else
// the first by name that answers decisions. Create opens the decider's
// page; the first decider is the default, and the mark moves on a
// decider's page.

import { useEffect, useRef } from "preact/hooks";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { createDecider, deciders } from "../../data/deciders.ts";
import { providers, providersError } from "../../data/providers.ts";
import { configDeciderHref } from "../../lib/hrefs.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { touch } from "../../lib/touch.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import { DeciderModelFields } from "./DeciderModelFields.tsx";
import { DeciderDrafts } from "./DeciderPage.state.ts";
import {
  deciderFieldOf,
  deciderProviders,
  heldProvider,
} from "./Deciders.model.ts";
import "./decider-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Deciders", href: "/admin/config/deciders" },
];

export function NewDecider() {
  const rows = providers.value;
  const error = providersError.value;
  const offered = byName(deciderProviders(rows ?? []));
  return (
    <Page
      steps={STEPS}
      title="New decider"
      loading={rows === null && error === null}
      error={error}
    >
      {rows !== null &&
        (offered.length === 0 ? (
          <p class="page-state">
            A decider runs on an OpenRouter or OpenAI-compatible provider.{" "}
            <a href="/admin/config/providers?new">Add a provider</a> first.
          </p>
        ) : (
          <Form
            providerId={
              offered.find(
                (p) =>
                  p.id === deciders.value?.find((x) => x.default)?.providerId,
              )?.id ?? offered[0]!.id
            }
          />
        ))}
    </Page>
  );
}

function Form({ providerId }: { providerId: string }) {
  const drafts = useRef<DeciderDrafts | null>(null);
  if (drafts.current === null) drafts.current = DeciderDrafts.blank(providerId);
  const d = drafts.current;
  const save = useSave(async () => {
    const from = address();
    const created = await createDecider({
      name: d.name.value.trim(),
      providerId: d.providerId.value,
      model: d.model.value?.id ?? "",
    });
    if (address() === from) navigate(configDeciderHref(created.name));
  }, deciderFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  // with a mouse the name takes the caret on arrival
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!touch()) nameField.current?.focus();
  }, []);
  // the provider the search opened on may be deleted meanwhile: the
  // first left that answers decisions stands in
  const rows = providers.value;
  useEffect(() => {
    const next = heldProvider(
      byName(deciderProviders(rows ?? [])),
      d.providerId.value,
    );
    if (next !== d.providerId.value) d.chooseProvider(next);
  }, [rows]);
  const name = d.name.value.trim();
  const taken = (deciders.value ?? []).some((x) => x.name === name);
  return (
    <form
      ref={form}
      class="decider-page"
      onSubmit={(e) => {
        e.preventDefault();
        // Create waits for a model, so only the name's rule is left
        void save.run(at("name", nameProblem(d.name.value)));
      }}
    >
      <Setting
        label="New decider"
        foot={
          <Foot
            save={save}
            dirty={
              name !== "" &&
              !taken &&
              d.model.value !== null &&
              !d.changing.value
            }
            label="Create decider"
            stack={taken}
            // the hint's place holds the buttons at the right
            start={
              <SettingHint>
                {taken && <span class="error">{name} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href="/admin/config/deciders">
                Cancel
              </a>
            }
          />
        }
      >
        <label class="field decider-page-name">
          <span class="label">Name</span>
          <input
            name="name"
            ref={nameField}
            autocomplete="off"
            spellcheck={false}
            placeholder="jev"
            aria-invalid={save.fieldError("name") !== null || undefined}
            disabled={save.busy}
            value={d.name.value}
            onInput={(e) => {
              d.name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <div class="decider-page-new-model">
          <span class="label">Model</span>
          <DeciderModelFields drafts={d} save={save} currentId={null} />
        </div>
      </Setting>
    </form>
  );
}
