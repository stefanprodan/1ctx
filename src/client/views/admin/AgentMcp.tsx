// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's MCP tab: one card of the servers it may use, each its name
// over its last refresh, the tools a turn gets and the access, Read or
// Read and write, a side the server has off disabled; Add over the
// servers it does not use yet, a new one on Read. Under it the tool
// schemas mode and the instructions the prompt would carry from the
// draft, each card a draft of its own. A model that takes no tools says
// so and shows neither, the saved links kept.

import { useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  AgentServer,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import { MAX_INSTRUCTIONS_BLOCK, offeredServers } from "../../../shared/mcp.ts";
import { updateAgent } from "../../data/agents.ts";
import { servers as serverRows } from "../../data/mcp.ts";
import { commas, showAll } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { RowsEnd, RowsLine, RowsNote, RowsTitle } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { serverLine, serverMeta } from "../people/People.model.ts";
import { cardBody, cardFieldOf } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { listed } from "./Agents.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import {
  isModeValue,
  MODE_HINT,
  MODE_OPTIONS,
  promptPreview,
} from "./Mcp.model.ts";

const OFF = "Disabled in the server config";

type Access = "read" | "write" | "none";

// the tools a turn gets from a server with these sides on
const toolCount = (server: McpServerSummary, link: AgentServer) =>
  offeredServers([server], [link])[0]?.tools.length ?? 0;

export function AgentMcp({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const takesTools = agent.model.tools;
  return (
    <>
      <Servers agent={agent} drafts={d} takesTools={takesTools} />
      {takesTools && serverRows.value !== null && (
        <Schemas agent={agent} drafts={d} />
      )}
    </>
  );
}

function Servers({
  agent,
  drafts: d,
  takesTools,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
  takesTools: boolean;
}) {
  const latest = useRef(agent);
  latest.current = agent;
  const all = serverRows.value;
  const now = useNow(60_000);
  // a server deleted since the save drops from it
  const chosen = () =>
    listed(d.servers.value, (s) => s.serverId, serverRows.value);
  const save = useSave(
    () =>
      d.save(async () => {
        const saved = await updateAgent(
          latest.current.id,
          cardBody(latest.current, { servers: chosen() }, loadedRows()),
        );
        d.resetServers(saved);
      }),
    cardFieldOf([]),
  );
  const links = chosen();
  const linkOf = (id: string) => links.find((l) => l.serverId === id);
  const rows = byName((all ?? []).filter((s) => linkOf(s.id) !== undefined));
  const set = (serverId: string, next: AgentServer | null) => {
    d.servers.value = [
      ...links.filter((l) => l.serverId !== serverId),
      ...(next === null ? [] : [next]),
    ];
    save.touch();
  };
  const listable = takesTools && all !== null && all.length > 0;
  // Save is the foot's submit
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        list
        title="MCP servers"
        action={
          listable && (
            <Finder
              label="MCP servers"
              trigger={
                <>
                  <Icon name="plus" size={14} />
                  Add server
                </>
              }
              disabled={save.busy}
              options={byName(
                all.filter((s) => linkOf(s.id) === undefined),
              ).map((s) => {
                const line = serverLine(s, now);
                const tools = serverMeta({
                  tools: toolCount(s, {
                    serverId: s.id,
                    read: true,
                    write: false,
                  }),
                });
                return {
                  value: s.id,
                  label: s.name,
                  sub: `${tools} · ${line.text}`,
                  subBad: line.bad,
                };
              })}
              mono
              wide
              align="right"
              placeholder="Find a server"
              none="No server matches"
              empty="Every server is added"
              onPick={(id) =>
                set(id, { serverId: id, read: true, write: false })
              }
            />
          )
        }
        foot={
          listable ? (
            <DraftFoot
              locked={d.saving.value}
              save={save}
              dirty={d.serversDirty(agent)}
              onDiscard={() => d.resetServers(latest.current)}
            />
          ) : undefined
        }
      >
        {all === null ? (
          <RowsNote>The servers did not load. Reload the page.</RowsNote>
        ) : all.length === 0 ? (
          <RowsNote>
            No MCP servers yet. <a href="/config/mcp">Add one</a> and it shows
            here.
          </RowsNote>
        ) : !takesTools ? (
          <RowsNote>This model takes no tools.</RowsNote>
        ) : rows.length === 0 ? (
          <RowsNote>No MCP servers.</RowsNote>
        ) : (
          rows.map((server) => {
            const link = linkOf(server.id)!;
            const line = serverLine(server, now);
            // what a turn gets: the link's sides the server has on too
            const access: Access = !server.read
              ? "none"
              : link.write && server.write
                ? "write"
                : "read";
            return (
              <RowsLine key={server.id} flush>
                <RowsTitle
                  name={server.name}
                  sub={line.text}
                  bad={line.bad}
                  mono
                />
                <span class="agent-page-server-end">
                  <span class="agent-page-tools">
                    {serverMeta({ tools: toolCount(server, link) })}
                  </span>
                  <Seg
                    label={`Access for ${server.name}`}
                    small
                    class="agent-page-access"
                    value={access}
                    options={[
                      {
                        value: "read",
                        label: "Read",
                        disabled: save.busy || !server.read,
                        title: server.read ? undefined : OFF,
                      },
                      {
                        value: "write",
                        label: "Read and write",
                        disabled: save.busy || !server.read || !server.write,
                        title: server.read && server.write ? undefined : OFF,
                      },
                    ]}
                    onPick={(value) =>
                      set(server.id, {
                        serverId: server.id,
                        read: true,
                        write: value === "write",
                      })
                    }
                  />
                </span>
                <RowsEnd>
                  <button
                    type="button"
                    class="btn-icon agent-page-remove"
                    aria-label={`Remove ${server.name}`}
                    title="Remove"
                    disabled={save.busy}
                    onClick={() => set(server.id, null)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </RowsEnd>
              </RowsLine>
            );
          })
        )}
      </Setting>
    </form>
  );
}

function Schemas({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useRef(agent);
  latest.current = agent;
  const save = useSave(
    () =>
      d.save(async () => {
        const saved = await updateAgent(
          latest.current.id,
          cardBody(latest.current, { mcpMode: d.mode.value }, loadedRows()),
        );
        d.resetMode(saved);
      }),
    cardFieldOf([]),
  );
  const preview = promptPreview(
    serverRows.value ?? [],
    listed(d.servers.value, (s) => s.serverId, serverRows.value),
  );
  // Save is the foot's submit
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Tool schemas"
        line={MODE_HINT[d.mode.value]}
        foot={
          <DraftFoot
            locked={d.saving.value}
            save={save}
            dirty={d.modeDirty(agent)}
            onDiscard={() => d.resetMode(latest.current)}
          />
        }
        action={
          <Seg
            label="Tool schemas"
            name="mcpMode"
            value={d.mode.value}
            options={MODE_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
            onPick={(value) => {
              if (isModeValue(value)) d.mode.value = value;
              save.touch();
            }}
          />
        }
      >
        {(preview.text !== "" || preview.warnings.length > 0) && (
          <Instructions preview={preview} />
        )}
      </Setting>
    </form>
  );
}

function Instructions({
  preview,
}: {
  preview: ReturnType<typeof promptPreview>;
}) {
  const { el, open, long } = useCut<HTMLPreElement>([preview.text]);
  const lines = preview.text.split("\n").length;
  return (
    <div class="agent-page-instructions">
      <div class="agent-page-instructions-head">
        <span>Instructions in the prompt</span>
        {preview.text !== "" && (
          <span class="agent-page-instructions-count">
            {commas(preview.count)} of {commas(MAX_INSTRUCTIONS_BLOCK)}{" "}
            characters
          </span>
        )}
      </div>
      {preview.from.length > 0 && (
        <span class="agent-page-instructions-from">
          From {preview.from.join(", ")}
        </span>
      )}
      {preview.warnings.map((w) => (
        <span key={w} class="agent-page-instructions-from error">
          {w}
        </span>
      ))}
      {preview.text !== "" && (
        <Fold
          cut={long.value && !open.value}
          framed
          onOpen={() => {
            open.value = true;
          }}
          label={showAll(lines)}
        >
          <pre
            ref={el}
            class={`textbox agent-page-block${
              open.value ? "" : " agent-page-block-cut"
            }`}
          >
            {preview.text}
          </pre>
        </Fold>
      )}
    </div>
  );
}
