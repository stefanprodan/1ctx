// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { MAX_NAME, type Wire } from "../../../shared/words.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { ApiError } from "../../data/api.ts";
import {
  createProvider,
  keys,
  providers,
  providersError,
} from "../../data/providers.ts";
import { configProviderHref, PROVIDERS_HREF } from "../../lib/hrefs.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { Select } from "../../ui/Select.tsx";
import { Choices } from "./Choices.tsx";
import { NewCard } from "./NewCard.tsx";
import {
  baseUrlProblem,
  matchingKey,
  PRESETS,
  preset,
  presetBaseUrl,
  providerFieldOf,
  providerRefusal,
} from "./Providers.model.ts";

const STEPS = [
  zoneStep("Config"),
  { label: "Providers", href: PROVIDERS_HREF },
];

// wire: the preset the form opens on
export function NewProvider({ wire }: { wire?: Wire } = {}) {
  const error = providersError.value;
  return (
    <Page
      steps={STEPS}
      title="New provider"
      loading={providers.value === null && error === null}
      error={error}
    >
      <Form initial={wire ?? PRESETS[0]!.wire} />
    </Page>
  );
}

function Form({ initial }: { initial: Wire }) {
  const wire = useSignal<Wire>(initial);
  const name = useSignal(preset(wire.value).name);
  const baseUrl = useSignal(preset(wire.value).baseUrl ?? "");
  // the key the admin picked; until then it follows the name
  const picked = useSignal<string | null>(null);
  const key = () => picked.value ?? matchingKey(keys.value, name.value);
  const chosen = preset(wire.value);
  // read at call time: the save keeps the first render's callback
  const body = () => {
    const p = preset(wire.value);
    return {
      name: name.value.trim(),
      wire: wire.value,
      baseUrl:
        p.fixed && p.baseUrl !== null
          ? p.baseUrl
          : baseUrl.value.trim().replace(/\/+$/, ""),
      keyName: key() === NO_KEY ? null : key(),
    };
  };
  const choose = (next: Wire) => {
    const was = preset(wire.value);
    wire.value = next;
    const now = preset(next);
    if (name.value.trim() === "" || name.value === was.name) {
      name.value = now.name;
    }
    baseUrl.value = presetBaseUrl(baseUrl.value, next);
    save.touch();
  };
  const save = useSave(async () => {
    const from = address();
    let created: Awaited<ReturnType<typeof createProvider>>;
    try {
      created = await createProvider(body());
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      throw new ApiError(err.status, providerRefusal(err.message));
    }
    if (address() === from) navigate(configProviderHref(created.name));
  }, providerFieldOf);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const trimmed = name.value.trim();
  const taken = (providers.value ?? []).some((p) => p.name === trimmed);
  return (
    <NewCard
      label="New provider"
      create="Create provider"
      cancel={PROVIDERS_HREF}
      save={save}
      ready={trimmed !== "" && (chosen.fixed || baseUrl.value.trim() !== "")}
      taken={taken ? trimmed : null}
      first="name"
      onSubmit={() => {
        void save.run(
          at("name", nameProblem(name.value)) ??
            (chosen.fixed
              ? null
              : at("baseUrl", baseUrlProblem(baseUrl.value))),
        );
      }}
    >
      <Choices
        options={PRESETS.map((p) => ({ ...p, value: p.wire }))}
        value={wire.value}
        disabled={busy}
        onPick={choose}
      />
      <div class="pair">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_NAME}
            aria-invalid={invalid("name") || undefined}
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <div class="field">
          <span class="label">Key file</span>
          <Select
            label="Key file"
            name="keyName"
            mono
            invalid={invalid("keyName")}
            disabled={busy}
            value={key()}
            options={keyOptions(keys.value, key())}
            onChange={(value) => {
              picked.value = value;
              save.touch();
            }}
          />
          {invalid("keyName") ? (
            <FieldError save={save} field="keyName" />
          ) : (
            <span class="hint">
              A key file is provider-&lt;name&gt;.key in the secrets directory.
            </span>
          )}
        </div>
        {!chosen.fixed && (
          <label class="field pair-wide">
            <span class="label label-required">Base URL</span>
            <input
              name="baseUrl"
              aria-required="true"
              autocomplete="off"
              spellcheck={false}
              placeholder={chosen.placeholder}
              aria-invalid={invalid("baseUrl") || undefined}
              disabled={busy}
              value={baseUrl.value}
              onInput={save.bind(baseUrl)}
            />
            {invalid("baseUrl") || chosen.hint === null ? (
              <FieldError save={save} field="baseUrl" />
            ) : (
              <span class="hint">{chosen.hint}</span>
            )}
          </label>
        )}
      </div>
    </NewCard>
  );
}
