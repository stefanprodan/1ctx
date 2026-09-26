// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New provider: the preset, which fixes the wire and fills or fixes
// the address; then the name, the key file, and the base URL unless
// the preset fixes it. A provider is never edited after.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { Wire } from "../../../shared/words.ts";
import { createProvider, keys } from "../../data/providers.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  baseUrlProblem,
  PRESETS,
  preset,
  presetBaseUrl,
  providerFieldOf,
} from "./Agents.model.ts";
import { Choices } from "./Choices.tsx";
import "./agents.css";

export function ProviderForm({ onDone }: { onDone: () => void }) {
  const wire = useSignal<Wire>(PRESETS[0]!.wire);
  const name = useSignal(preset(wire.value).name);
  const baseUrl = useSignal(preset(wire.value).baseUrl ?? "");
  const keyName = useSignal(NO_KEY);
  const chosen = preset(wire.value);
  // read from the signals at call time: the save keeps the callback of
  // the first render, and the preset may have changed since
  const body = () => {
    const p = preset(wire.value);
    return {
      name: name.value.trim(),
      wire: wire.value,
      baseUrl:
        p.fixed && p.baseUrl !== null
          ? p.baseUrl
          : baseUrl.value.trim().replace(/\/+$/, ""),
      keyName: keyName.value === NO_KEY ? null : keyName.value,
    };
  };
  // a preset fills what the admin has not typed yet
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
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await createProvider(body());
    onDone();
  }, providerFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value)) ??
        (chosen.fixed ? null : at("baseUrl", baseUrlProblem(baseUrl.value))),
    );
  };
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
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
            value={keyName.value}
            options={keyOptions(keys.value, keyName.value)}
            onChange={(value) => {
              keyName.value = value;
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
              placeholder="http://host:port/v1"
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
      <Foot
        save={save}
        dirty={true}
        label="New provider"
        start={<span />}
        before={
          <button type="button" class="btn" disabled={busy} onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}
