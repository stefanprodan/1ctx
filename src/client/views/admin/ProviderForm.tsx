// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New provider: the preset, which fixes the wire and, for OpenRouter,
// the address; then the name, the key file, and the base URL when the
// preset leaves it to the admin. A provider is never edited after.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { Wire } from "../../../shared/words.ts";
import { createProvider } from "../../data/providers.ts";
import { shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  baseUrlProblem,
  keyNameProblem,
  nameProblem,
  PRESETS,
  preset,
  providerFieldOf,
} from "./Agents.model.ts";
import "./agents.css";

export function ProviderForm({ onDone }: { onDone: () => void }) {
  const wire = useSignal<Wire>("openrouter");
  const name = useSignal(preset(wire.value).name);
  const baseUrl = useSignal("");
  const keyName = useSignal(preset(wire.value).name);
  const chosen = preset(wire.value);
  // read from the signals at call time: the save keeps the callback of
  // the first render, and the preset may have changed since
  const body = () => {
    const p = preset(wire.value);
    return {
      name: name.value.trim(),
      wire: wire.value,
      baseUrl:
        p.baseUrl === null
          ? baseUrl.value.trim().replace(/\/+$/, "")
          : p.baseUrl,
      keyName: keyName.value.trim() === "" ? null : keyName.value.trim(),
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
    if (keyName.value.trim() === "" || keyName.value === was.name) {
      keyName.value = now.name;
    }
    save.touch();
  };
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await createProvider(body());
    onDone();
  }, providerFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    save.touch();
  };
  const busy = save.busy;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value)) ??
        (chosen.baseUrl === null
          ? at("baseUrl", baseUrlProblem(baseUrl.value))
          : null) ??
        at("keyName", keyNameProblem(keyName.value)),
    );
  };
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
      <div class="agents-presets">
        {PRESETS.map((p) => (
          <button
            key={p.wire}
            type="button"
            aria-pressed={wire.value === p.wire}
            disabled={busy}
            class={`agents-preset${wire.value === p.wire ? " agents-preset-on" : ""}`}
            onClick={() => choose(p.wire)}
          >
            <span class="agents-preset-label">{p.label}</span>
            <span class="agents-preset-text">{p.text}</span>
          </button>
        ))}
      </div>
      <div class="agents-fields">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="openrouter"
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
        <label class="field">
          <span class="label">Key file</span>
          <input
            name="keyName"
            autocomplete="off"
            spellcheck={false}
            placeholder="none"
            aria-invalid={invalid("keyName") || undefined}
            disabled={busy}
            value={keyName.value}
            onInput={bind(keyName)}
          />
          {invalid("keyName") ? (
            <FieldError save={save} field="keyName" />
          ) : (
            <span class="hint">
              {keyName.value.trim() === ""
                ? "Leave it empty for a server without a key."
                : `${keyName.value.trim()}.key in the secrets directory.`}
            </span>
          )}
        </label>
        {chosen.baseUrl === null && (
          <label class="field agents-field-wide">
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
              onInput={bind(baseUrl)}
            />
            {invalid("baseUrl") ? (
              <FieldError save={save} field="baseUrl" />
            ) : (
              <span class="hint">
                /models and /chat/completions are under it.
              </span>
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
          <button type="button" class="btn" onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}
