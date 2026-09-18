// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's MCP servers: a line per registered server with two
// boxes, read and write, a side the server has off shown faint with
// the word, so the admin sees the intersection; the mode under them;
// then what the prompt would carry from the rows loaded, with a
// warning for a server a cap leaves out, and View for the block.

import { useSignal } from "@preact/signals";
import type {
  AgentServer,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import type { McpMode } from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";
import {
  RowsCheck,
  RowsEnd,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  isModeValue,
  MODE_HINT,
  MODE_OPTIONS,
  promptPreview,
} from "./Mcp.model.ts";
import "./mcp.css";

export function McpPicker({
  available,
  loadedAt,
  chosen,
  mode,
  takesTools,
  busy,
  onToggle,
  onMode,
}: {
  // null when the list did not load
  available: McpServerSummary[] | null;
  loadedAt: number | null;
  chosen: AgentServer[];
  mode: McpMode;
  // false for a model without the tools flag
  takesTools: boolean;
  busy: boolean;
  onToggle: (serverId: string, side: "read" | "write") => void;
  onMode: (mode: McpMode) => void;
}) {
  const viewing = useSignal(false);
  const linkOf = (id: string) => chosen.find((s) => s.serverId === id);
  const preview =
    available === null || !takesTools ? null : promptPreview(available, chosen);
  const side = (
    server: McpServerSummary,
    which: "read" | "write",
    label: string,
  ) => {
    const link = linkOf(server.id);
    const on = link?.[which] ?? false;
    const off = !server[which];
    return (
      <RowsCheck
        name={`${which}:${server.name}`}
        checked={on}
        disabled={busy}
        faint={off}
        note={off ? "off on the server" : undefined}
        onChange={() => onToggle(server.id, which)}
      >
        {label}
      </RowsCheck>
    );
  };
  return (
    <div class="field pair-wide">
      <RowsListHead
        label="MCP servers"
        hint={
          loadedAt !== null && available !== null
            ? `refreshed ${ago(loadedAt, Date.now())}`
            : undefined
        }
      />
      {available === null ? (
        <span class="hint">The servers did not load. Reload the page.</span>
      ) : available.length === 0 ? (
        <span class="hint">
          No MCP servers yet. <a href="/admin/mcp">Add one</a> and it shows
          here.
        </span>
      ) : !takesTools ? (
        <span class="hint">This model takes no tools.</span>
      ) : (
        <>
          <RowsList>
            {available.map((server) => (
              <RowsLine key={server.id} flush>
                <RowsTitle name={server.name} mono />
                <RowsEnd>
                  {side(server, "read", "Read")}
                  {side(server, "write", "Write")}
                </RowsEnd>
              </RowsLine>
            ))}
          </RowsList>
          <div class="field">
            <span class="label">Tool schemas</span>
            <Select
              label="Tool schemas"
              name="mcpMode"
              value={mode}
              options={MODE_OPTIONS}
              disabled={busy}
              onChange={(value) => {
                if (isModeValue(value)) onMode(value);
              }}
            />
            <span class="hint">{MODE_HINT[mode]}</span>
          </div>
          {preview !== null &&
            (preview.line !== "" || preview.warnings.length > 0) && (
              <div class="mcp-preview">
                {preview.line !== "" && (
                  <span class="mcp-note">{preview.line}</span>
                )}
                {preview.warnings.map((warning) => (
                  <span key={warning} class="mcp-note error">
                    {warning}
                  </span>
                ))}
                {preview.text !== "" && (
                  <>
                    <button
                      type="button"
                      class="btn btn-small mcp-toggle"
                      onClick={() => {
                        viewing.value = !viewing.value;
                      }}
                    >
                      {viewing.value ? "Hide" : "View"}
                    </button>
                    {viewing.value && <pre class="textbox">{preview.text}</pre>}
                  </>
                )}
              </div>
            )}
        </>
      )}
    </div>
  );
}
