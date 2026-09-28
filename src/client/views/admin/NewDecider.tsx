// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import { MAX_NAME } from "../../../shared/words.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { createDecider, deciders } from "../../data/deciders.ts";
import { providers, providersError } from "../../data/providers.ts";
import {
  configDeciderHref,
  DECIDERS_HREF,
  PROVIDERS_HREF,
} from "../../lib/hrefs.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { DeciderModelFields } from "./DeciderModelFields.tsx";
import { DeciderDrafts } from "./DeciderPage.state.ts";
import {
  deciderFieldOf,
  deciderProviders,
  heldProvider,
} from "./Deciders.model.ts";
import { NewCard } from "./NewCard.tsx";
import "./decider-page.css";

const STEPS = [zoneStep("Config"), { label: "Deciders", href: DECIDERS_HREF }];

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
            <a href={`${PROVIDERS_HREF}?new`}>Add a provider</a> first.
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
  // the provider the search opened on may be deleted meanwhile
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
    <NewCard
      label="New decider"
      create="Create decider"
      cancel={DECIDERS_HREF}
      save={save}
      ready={name !== "" && d.model.value !== null && !d.changing.value}
      taken={taken ? name : null}
      first="name"
      // Create waits for a model, so only the name is checked
      onSubmit={() => void save.run(at("name", nameProblem(d.name.value)))}
    >
      <label class="field decider-page-name">
        <span class="label">Name</span>
        <input
          name="name"
          autocomplete="off"
          spellcheck={false}
          maxLength={MAX_NAME}
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
        <DeciderModelFields
          drafts={d}
          save={save}
          currentId={null}
          autofocus={false}
        />
      </div>
    </NewCard>
  );
}
