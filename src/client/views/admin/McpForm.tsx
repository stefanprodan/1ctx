// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New server: the name, the URL, the key picked from the mcp- files,
// the timeout, the switches and the three pattern fields. Add
// discovers first and saves what it found; the server's 400 or 502
// words show under the field they name, the rest over the buttons.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { shapeServerName } from "../../../shared/words.ts";
import { addServer, callTimeoutMs, keys } from "../../data/mcp.ts";
import { at, type Save, useFocusField, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsCheck } from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  KEY_HINT,
  mcpFieldOf,
  timeoutProblem,
  timeoutText,
} from "./Mcp.model.ts";
import {
  type McpSettings,
  NEW_SERVER,
  settingsBody,
  useMcpSettings,
} from "./McpSettings.ts";
import "./mcp.css";

const PATTERN_HINT = "One per line: a name, or a prefix ending in *";

export function McpFields({
  settings,
  busy,
  save,
  marks,
}: {
  settings: McpSettings;
  busy: boolean;
  save: Save;
  // under each pattern field, the patterns matching no tool
  marks?: { read: string; write: string; excluded: string };
}) {
  const invalid = (field: string) => save.fieldError(field) !== null;
  const onChange = (field: keyof McpSettings, value: string | boolean) => {
    (settings[field] as { value: string | boolean }).value = value;
    save.touch();
  };
  const { read, write, instructionsOn, timeout } = settings;
  const { readText, writeText, excludedText } = settings;
  const switchOf = (
    field: "read" | "write" | "instructionsOn",
    on: boolean,
    label: string,
  ) => (
    <RowsCheck
      name={field}
      checked={on}
      disabled={busy}
      onChange={() => onChange(field, !on)}
    >
      {label}
    </RowsCheck>
  );
  const patterns = (
    field: "readText" | "writeText" | "excludedText",
    name: "readPatterns" | "writePatterns" | "excludedPatterns",
    label: string,
    value: string,
    mark: string | undefined,
    hint: string,
  ) => (
    <label class="field">
      <span class="label">{label}</span>
      <textarea
        name={name}
        class="mcp-patterns"
        rows={4}
        spellcheck={false}
        aria-invalid={invalid(name) || undefined}
        disabled={busy}
        value={value}
        onInput={(e) =>
          onChange(field, (e.currentTarget as HTMLTextAreaElement).value)
        }
      />
      {invalid(name) ? (
        <FieldError save={save} field={name} />
      ) : mark ? (
        <span class="hint error">{mark}</span>
      ) : (
        <span class="hint">{hint}</span>
      )}
    </label>
  );
  return (
    <>
      {/* the switches and the timeout share a row, the three pattern
          fields the next, so the form reads as two lines of settings */}
      <div class="mcp-field-wide pair mcp-head-row">
        <div class="field">
          <span class="label">Offered</span>
          <div class="mcp-switches">
            {switchOf("read", read.value, "Read tools")}
            {switchOf("write", write.value, "Write tools")}
            {switchOf("instructionsOn", instructionsOn.value, "Instructions")}
          </div>
        </div>
        <label class="field">
          <span class="label">Call timeout (seconds)</span>
          <input
            name="timeoutMs"
            class="mcp-mono"
            inputMode="decimal"
            autocomplete="off"
            placeholder={timeoutText(callTimeoutMs.value)}
            aria-invalid={invalid("timeoutMs") || undefined}
            disabled={busy}
            value={timeout.value}
            onInput={(e) =>
              onChange("timeout", (e.currentTarget as HTMLInputElement).value)
            }
          />
          <FieldError save={save} field="timeoutMs" />
        </label>
      </div>
      <div class="mcp-field-wide mcp-pattern-row">
        {patterns(
          "readText",
          "readPatterns",
          "Read",
          readText.value,
          marks?.read,
          PATTERN_HINT,
        )}
        {patterns(
          "writeText",
          "writePatterns",
          "Write",
          writeText.value,
          marks?.write,
          "Empty means everything not read or excluded",
        )}
        {patterns(
          "excludedText",
          "excludedPatterns",
          "Excluded",
          excludedText.value,
          marks?.excluded,
          "Never offered to any agent",
        )}
      </div>
    </>
  );
}

export function McpForm({ onDone }: { onDone: () => void }) {
  const name = useSignal("");
  const url = useSignal("");
  const keyName = useSignal(NO_KEY);
  const settings = useMcpSettings(NEW_SERVER);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await addServer({
      name: name.value.trim(),
      url: url.value.trim(),
      keyName: keyName.value === NO_KEY ? null : keyName.value,
      ...settingsBody(settings),
    });
    onDone();
  }, mcpFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", name.value.trim() === "" ? "A name is required" : null) ??
        at("url", url.value.trim() === "" ? "A URL is required" : null) ??
        at("timeoutMs", timeoutProblem(settings.timeout.value)),
    );
  };
  const busy = save.busy;
  return (
    <form class="mcp-form" ref={form} onSubmit={submit}>
      <div class="mcp-fields">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            class="mcp-mono"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="flux"
            aria-invalid={invalid("name") || undefined}
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = shapeServerName(
                (e.currentTarget as HTMLInputElement).value,
              );
              save.touch();
            }}
          />
          {invalid("name") ? (
            <FieldError save={save} field="name" />
          ) : (
            <span class="hint">
              Tools are named mcp__{name.value || "name"}__tool
            </span>
          )}
        </label>
        <label class="field">
          <span class="label label-required">URL</span>
          <input
            name="url"
            class="mcp-mono"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://host/mcp"
            aria-invalid={invalid("url") || undefined}
            disabled={busy}
            value={url.value}
            onInput={save.bind(url)}
          />
          <FieldError save={save} field="url" />
        </label>
        <div class="field">
          <span class="label">Key</span>
          <Select
            label="Key"
            name="keyName"
            mono
            value={keyName.value}
            options={keyOptions(keys.value, keyName.value)}
            disabled={busy}
            invalid={invalid("keyName")}
            onChange={(value) => {
              keyName.value = value;
              save.touch();
            }}
          />
          {invalid("keyName") ? (
            <FieldError save={save} field="keyName" />
          ) : (
            <span class="hint">{KEY_HINT}</span>
          )}
        </div>
        <McpFields settings={settings} busy={busy} save={save} />
      </div>
      <Foot
        save={save}
        dirty
        label="Add server"
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
