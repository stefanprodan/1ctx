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
import { useEffect, useRef } from "preact/hooks";
import type {
  McpChange,
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
import {
  ago,
  firstSentence,
  reason,
  sentence,
  showAll,
} from "../../lib/format.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  RowsBad,
  RowsList,
  RowsListHead,
  RowsMeta,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  changeLine,
  characters,
  endpointDirty,
  instructionsBox,
  KEY_HINT,
  mcpFieldOf,
  metaLine,
  patternText,
  servedLine,
  settingsDirty,
  timeoutMs,
  timeoutProblem,
  timeoutText,
  toolGroups,
  unmatchedIn,
  unmatchedLine,
} from "./Mcp.model.ts";
import { McpFields } from "./McpForm.tsx";
import "./mcp.css";

function Change({ change, now }: { change: McpChange; now: number }) {
  const line = changeLine(change, now);
  const groups: [string, string[]][] = [
    ["Added", change.added],
    ["Removed", change.removed],
    ["Changed", change.changed],
  ];
  const named = groups.filter(([, names]) => names.length > 0);
  if (named.length === 0) return <span class="mcp-note">{line}</span>;
  return (
    <details class="mcp-change">
      <summary class="mcp-note mcp-change-head">{line}</summary>
      <div class="mcp-change-lines">
        {named.map(([label, names]) => (
          <span key={label} class="mcp-change-line">
            <span class="mcp-change-kind">{label}</span>
            {names.join(", ")}
          </span>
        ))}
      </div>
    </details>
  );
}

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
  open,
  onToggle,
}: {
  tool: McpToolSummary;
  reason?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <RowsTitle
            name={tool.name}
            sub={firstSentence(tool.description) || undefined}
            mono
          />
          {why && <RowsMeta bad>{why}</RowsMeta>}
        </>
      }
    >
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
    </RowsOpen>
  );
}

function Group({
  label,
  tools,
}: {
  label: string;
  tools: { tool: McpToolSummary; reason?: string }[];
}) {
  const open = useSignal<string | null>(null);
  if (tools.length === 0) return null;
  return (
    <div class="mcp-group">
      <RowsListHead label={label} hint={String(tools.length)} />
      <RowsList>
        {tools.map(({ tool, reason: why }) => (
          <ToolLine
            key={tool.name}
            tool={tool}
            reason={why}
            open={open.value === tool.name}
            onToggle={() => {
              open.value = open.value === tool.name ? null : tool.name;
            }}
          />
        ))}
      </RowsList>
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
  const dirty = endpointDirty(server, url.value, keyName.value);
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
            options={keyOptions(
              keys.value,
              keyName.value === NO_KEY ? null : keyName.value,
            )}
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
  useEffect(() => {
    if (!open) expanded.value = false;
  }, [open]);
  const asking = useSignal(false);
  const refreshing = useSignal(false);
  const refreshFailure = useSignal<{ words: string; at: number } | null>(null);
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
  const dirty = settingsDirty(server, {
    read: read.value,
    write: write.value,
    instructionsOn: instructionsOn.value,
    timeout: timeout.value,
    patterns,
  });
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
      refreshFailure.value = { words: reason(err), at: Date.now() };
      // The failed route has no row, so read the failure the server kept.
      await loadMcp();
      refreshFailure.value = null;
    }
    refreshing.value = false;
  };
  const remove = () => save.act("delete", () => deleteServer(server.id));
  const failed = refreshFailure.value;
  const meta =
    failed === null
      ? metaLine(server, now)
      : { text: `refresh failed ${ago(failed.at, now)}`, bad: true };
  const box = instructionsBox(server.name, server.instructions, expanded.value);
  const busy = save.busy || refreshing.value;
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <RowsTitle name={server.name} sub={server.url} mono />
          <RowsMeta>
            {`Read ${server.read ? "on" : "off"} · Write ${server.write ? "on" : "off"} · `}
            {/* only the failure is red, the switches keep their colour */}
            {meta.bad ? <RowsBad>{meta.text}</RowsBad> : meta.text}
          </RowsMeta>
        </>
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
        {(failed !== null || server.refreshError !== null) && (
          <span class="mcp-note error">
            {sentence(failed?.words ?? server.refreshError ?? "")}{" "}
            {sentence(servedLine(server, now))}
          </span>
        )}
        {server.lastChange !== null && (
          <Change change={server.lastChange} now={now} />
        )}
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
              <span class="label">Instructions for the agent</span>
              {instructionsOn.value && server.instructions !== "" && (
                <span class="hint">{characters(box.count)}</span>
              )}
            </span>
            {!instructionsOn.value ? (
              <span class="hint">off, not sent</span>
            ) : server.instructions === "" ? (
              <span class="hint">Server sent no instructions</span>
            ) : (
              <Fold
                cut={box.cut && !expanded.value}
                onOpen={() => {
                  expanded.value = true;
                }}
                label={showAll(box.lines)}
                framed
              >
                <pre class="textbox">{box.text}</pre>
              </Fold>
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
                  disabled={busy}
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
