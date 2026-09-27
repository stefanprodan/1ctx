// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New MCP server: the name, the URL and the key file in one card with
// one Create, as New provider. Create lists the server's tools first
// and opens its Tools tab, where the matchers are set; until then read
// matches nothing and write is off, so no agent is offered a tool.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { shapeServerName } from "../../../shared/names.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { addServer, keys, servers, serversError } from "../../data/mcp.ts";
import { configMcpHref } from "../../lib/hrefs.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { touch } from "../../lib/touch.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import { KEY_HINT, mcpFieldOf } from "./Mcp.model.ts";
import "./mcp-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "MCP Servers", href: "/config/mcp" },
];

export function NewMcpServer() {
  const error = serversError.value;
  return (
    <Page
      steps={STEPS}
      title="New server"
      loading={servers.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const name = useSignal("");
  const url = useSignal("");
  const keyName = useSignal(NO_KEY);
  const form = useRef<HTMLFormElement>(null);
  // with a mouse the name takes the caret on arrival
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!touch()) nameField.current?.focus();
  }, []);
  const save = useSave(async () => {
    const from = address();
    const created = await addServer({
      name: name.value.trim(),
      url: url.value.trim(),
      keyName: keyName.value === NO_KEY ? null : keyName.value,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: [],
      writePatterns: [],
      excludedPatterns: [],
    });
    if (address() === from) navigate(configMcpHref(created.name, "tools"));
  }, mcpFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const trimmed = name.value.trim();
  const taken = (servers.value ?? []).some((s) => s.name === trimmed);
  return (
    <form
      class="mcp-page"
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("name", trimmed === "" ? "A name is required" : null) ??
            at("url", url.value.trim() === "" ? "A URL is required" : null),
        );
      }}
    >
      <Setting
        label="New server"
        foot={
          <Foot
            save={save}
            dirty={trimmed !== "" && !taken && url.value.trim() !== ""}
            label="Create server"
            stack={taken}
            start={
              <SettingHint>
                {taken && <span class="error">{trimmed} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href="/config/mcp">
                Cancel
              </a>
            }
          />
        }
      >
        <div class="pair">
          <label class="field">
            <span class="label label-required">Name</span>
            <input
              name="name"
              ref={nameField}
              class="mcp-page-mono"
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
                Tools are named mcp__{trimmed || "name"}__tool
              </span>
            )}
          </label>
          <div class="field">
            <span class="label">Key file</span>
            <Select
              label="Key file"
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
          <label class="field pair-wide">
            <span class="label label-required">URL</span>
            <input
              name="url"
              class="mcp-page-mono"
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
        </div>
      </Setting>
    </form>
  );
}
