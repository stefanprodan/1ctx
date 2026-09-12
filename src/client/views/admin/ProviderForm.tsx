// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New provider: the preset, which fixes the wire and, for OpenRouter,
// the address; then the name, the key file, and the base URL when the
// preset leaves it to the admin. A provider is never edited after.

import { useSignal } from "@preact/signals";
import type { Wire } from "../../../shared/words.ts";
import { createProvider } from "../../data/providers.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import {
  baseUrlProblem,
  keyNameProblem,
  nameProblem,
  PRESETS,
  preset,
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
  const save = useSave(async () => {
    await createProvider(body());
    onDone();
  });
  const bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    save.touch();
  };
  const busy = save.status.value === "busy";
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      nameProblem(name.value) ??
        (chosen.baseUrl === null ? baseUrlProblem(baseUrl.value) : null) ??
        keyNameProblem(keyName.value),
    );
  };
  return (
    <form class="agents-form" onSubmit={submit}>
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
          <span class="label">Name</span>
          <input
            name="name"
            autocomplete="off"
            spellcheck={false}
            placeholder="openrouter"
            disabled={busy}
            value={name.value}
            onInput={bind(name)}
          />
        </label>
        <label class="field">
          <span class="label">Key file</span>
          <input
            name="keyName"
            autocomplete="off"
            spellcheck={false}
            placeholder="none"
            disabled={busy}
            value={keyName.value}
            onInput={bind(keyName)}
          />
          <span class="agents-hint">
            {keyName.value.trim() === ""
              ? "Leave it empty for a server without a key."
              : `${keyName.value.trim()}.key in the secrets directory.`}
          </span>
        </label>
        {chosen.baseUrl === null && (
          <label class="field agents-field-wide">
            <span class="label">Base URL</span>
            <input
              name="baseUrl"
              autocomplete="off"
              spellcheck={false}
              placeholder="http://host:port/v1"
              disabled={busy}
              value={baseUrl.value}
              onInput={bind(baseUrl)}
            />
            <span class="agents-hint">
              /models and /chat/completions are under it.
            </span>
          </label>
        )}
      </div>
      <Foot
        status={save.status.value}
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
