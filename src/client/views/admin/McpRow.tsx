// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One MCP server's row: the head with the tools and the last check,
// Refresh at its end, and open in place the last change, the server's
// own words, the endpoint with its own Change button since it
// discovers first, the settings with Save, the tools in the four
// groups the fields give live, the instructions as the prompt carries
// them, and Delete asked once. Everything the server wrote is shown as
// text; the parameters are the one HTML, rendered on the server.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../shared/contracts/mcp.ts";
import { patternLines } from "../../../shared/mcp.ts";
import {
  deleteServer,
  keys,
  loadMcp,
  patchServer,
  refreshServer,
} from "../../data/mcp.ts";
import { firstSentence, reason } from "../../lib/format.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  changeLine,
  characters,
  instructionsBox,
  KEY_HINT,
  keyOptions,
  mcpFieldOf,
  metaLine,
  NO_KEY,
  patternText,
  servedLine,
  timeoutMs,
  timeoutProblem,
  timeoutText,
  toolGroups,
  unmatchedIn,
  unmatchedLine,
} from "./Mcp.model.ts";
import { McpFields } from "./McpForm.tsx";
import "./mcp.css";

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: string;
}) {
  return (
    <>
      <span class="mcp-fact-label">{label}</span>
      <span class={`mcp-fact${mono ? " mcp-fact-mono" : ""}`}>{children}</span>
    </>
  );
}

function ToolLine({
  tool,
  reason: why,
}: {
  tool: McpToolSummary;
  reason?: string;
}) {
  return (
    <details class="mcp-tool">
      <summary class="mcp-tool-head">
        <span class="mcp-tool-name">{tool.name}</span>
        <span class="mcp-tool-desc">{firstSentence(tool.description)}</span>
        {why && <span class="mcp-tool-reason">{why}</span>}
      </summary>
      <div class="mcp-tool-body">
        {tool.description !== "" && (
          <span class="mcp-tool-text">{tool.description}</span>
        )}
        <div
          class="mcp-tool-params"
          // rendered on the server from the schema's JSON inside a code
          // fence, as the Tools page shows a built-in's parameters
          dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
        />
      </div>
    </details>
  );
}

function Group({
  label,
  tools,
}: {
  label: string;
  tools: { tool: McpToolSummary; reason?: string }[];
}) {
  if (tools.length === 0) return null;
  return (
    <div class="mcp-group">
      <span class="mcp-group-head">
        <span class="label">{label}</span>
        <span class="mcp-group-count">{tools.length}</span>
      </span>
      <div class="mcp-tools">
        {tools.map(({ tool, reason: why }) => (
          <ToolLine key={tool.name} tool={tool} reason={why} />
        ))}
      </div>
    </div>
  );
}

// the endpoint goes alone: it discovers first, and a 502 keeps what
// was typed with the words under the fields
function Endpoint({ server }: { server: McpServerSummary }) {
  const url = useSignal(server.url);
  const keyName = useSignal(server.keyName ?? NO_KEY);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const body: { url?: string; keyName?: string | null } = {};
    if (url.value.trim() !== server.url) body.url = url.value.trim();
    const key = keyName.value === NO_KEY ? null : keyName.value;
    if (key !== server.keyName) body.keyName = key;
    await patchServer(server.id, body);
  }, mcpFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const dirty =
    url.value.trim() !== server.url ||
    (keyName.value === NO_KEY ? null : keyName.value) !== server.keyName;
  const busy = save.busy;
  return (
    <form
      class="mcp-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(
          at("url", url.value.trim() === "" ? "A URL is required" : null),
        );
      }}
    >
      <div class="mcp-fields">
        <label class="field">
          <span class="label">URL</span>
          <input
            name="url"
            class="mcp-mono"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={invalid("url") || undefined}
            disabled={busy}
            value={url.value}
            onInput={(e) => {
              url.value = (e.currentTarget as HTMLInputElement).value;
              save.touch();
            }}
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
            options={keyOptions(keys.value, server.keyName)}
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
            <span class="hint">
              {server.keyName === null
                ? KEY_HINT
                : server.hasKey
                  ? `${server.keyName}.key is present`
                  : `${server.keyName}.key is missing`}
            </span>
          )}
        </div>
      </div>
      <Foot save={save} dirty={dirty} label="Change endpoint" />
    </form>
  );
}

export function ServerRow({
  server,
  now,
  open,
  onToggle,
}: {
  server: McpServerSummary;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const read = useSignal(server.read);
  const write = useSignal(server.write);
  const instructionsOn = useSignal(server.instructionsOn);
  const timeout = useSignal(timeoutText(server.timeoutMs));
  const readText = useSignal(patternText(server.readPatterns));
  const writeText = useSignal(patternText(server.writePatterns));
  const excludedText = useSignal(patternText(server.excludedPatterns));
  const expanded = useSignal(false);
  const asking = useSignal(false);
  const refreshing = useSignal(false);
  const refreshFailure = useSignal<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await patchServer(server.id, {
      read: read.value,
      write: write.value,
      instructionsOn: instructionsOn.value,
      timeoutMs: timeoutMs(timeout.value),
      readPatterns: patternLines(readText.value),
      writePatterns: patternLines(writeText.value),
      excludedPatterns: patternLines(excludedText.value),
    });
  }, mcpFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const patterns = {
    read: patternLines(readText.value),
    write: patternLines(writeText.value),
    excluded: patternLines(excludedText.value),
  };
  const dirty =
    read.value !== server.read ||
    write.value !== server.write ||
    instructionsOn.value !== server.instructionsOn ||
    timeoutMs(timeout.value) !== server.timeoutMs ||
    patternText(patterns.read) !== patternText(server.readPatterns) ||
    patternText(patterns.write) !== patternText(server.writePatterns) ||
    patternText(patterns.excluded) !== patternText(server.excludedPatterns);
  const groups = toolGroups(server, patterns);
  const marks = {
    read: unmatchedLine(unmatchedIn(server, patterns.read)),
    write: unmatchedLine(unmatchedIn(server, patterns.write)),
    excluded: unmatchedLine(unmatchedIn(server, patterns.excluded)),
  };
  const refresh = async () => {
    refreshing.value = true;
    refreshFailure.value = null;
    try {
      await refreshServer(server.id);
    } catch (err) {
      refreshFailure.value = reason(err);
      // the server records the failure on the row, so the list learns it
      void loadMcp();
    }
    refreshing.value = false;
  };
  const remove = () => save.act("delete", () => deleteServer(server.id));
  const meta = metaLine(server, now);
  const change = changeLine(server.lastChange, now);
  const box = instructionsBox(server.name, server.instructions, expanded.value);
  const busy = save.busy || refreshing.value;
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <RowsTitle
          name={server.name}
          sub={
            refreshFailure.value !== null ? (
              <span class="error" role="alert">
                {refreshFailure.value}
              </span>
            ) : meta.bad ? (
              <span class="error">{meta.text}</span>
            ) : (
              meta.text
            )
          }
          mono
        />
      }
      end={
        <button
          type="button"
          class="btn btn-small"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {refreshing.value ? "Refreshing" : "Refresh"}
        </button>
      }
    >
      <div class="mcp-open">
        {server.refreshError !== null && (
          <span class="mcp-note error">
            {server.refreshError}, {servedLine(server, now)}
          </span>
        )}
        {change !== "" && <span class="mcp-note">{change}</span>}
        <div class="mcp-facts">
          <Fact label="Server" mono>
            {`${server.serverName || "unnamed"} ${server.serverVersion}`.trim()}
          </Fact>
          <Fact label="Protocol" mono>
            {server.protocolVersion}
          </Fact>
        </div>
        <Endpoint key={`${server.url}\n${server.keyName}`} server={server} />
        <form
          class="mcp-form"
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void save.run(at("timeoutMs", timeoutProblem(timeout.value)));
          }}
        >
          <div class="mcp-fields">
            <McpFields
              read={read.value}
              write={write.value}
              instructionsOn={instructionsOn.value}
              timeout={timeout.value}
              readText={readText.value}
              writeText={writeText.value}
              excludedText={excludedText.value}
              busy={busy}
              invalid={invalid}
              save={save}
              marks={marks}
              onChange={(field, value) => {
                const target = {
                  read,
                  write,
                  instructionsOn,
                  timeout,
                  readText,
                  writeText,
                  excludedText,
                }[field] as { value: string | boolean };
                target.value = value;
                save.touch();
              }}
            />
          </div>
          <Group label="Read" tools={groups.read.map((tool) => ({ tool }))} />
          <Group label="Write" tools={groups.write.map((tool) => ({ tool }))} />
          <Group
            label="Excluded"
            tools={groups.excluded.map((tool) => ({ tool }))}
          />
          <Group label="Unusable" tools={groups.unusable} />
          <div class="mcp-instructions">
            <span class="mcp-instructions-head">
              <span class="label">Instructions for the model</span>
              {instructionsOn.value && server.instructions !== "" && (
                <span class="hint">{characters(box.count)}</span>
              )}
            </span>
            {server.instructions === "" ? (
              <span class="hint">Server sent no instructions</span>
            ) : !instructionsOn.value ? (
              <span class="hint">off, not sent</span>
            ) : (
              <>
                <pre class="mcp-block">{box.text}</pre>
                {box.canToggle && (
                  <button
                    type="button"
                    class="btn btn-small mcp-toggle"
                    onClick={() => {
                      expanded.value = !expanded.value;
                    }}
                  >
                    {expanded.value ? "Show less" : "Show all"}
                  </button>
                )}
              </>
            )}
          </div>
          <Foot
            save={save}
            dirty={dirty}
            label="Save"
            start={
              asking.value ? (
                <>
                  <span class="mcp-ask">Delete {server.name}?</span>
                  <button
                    type="button"
                    class="btn btn-danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {save.pending.value === "delete" ? "Deleting" : "Delete"}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => {
                      asking.value = false;
                      save.touch();
                    }}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  class="btn"
                  onClick={() => {
                    asking.value = true;
                  }}
                >
                  Delete
                </button>
              )
            }
          />
        </form>
      </div>
    </RowsOpen>
  );
}
