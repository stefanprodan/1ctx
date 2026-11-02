// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import { MAX_INSTRUCTIONS_BLOCK, offeredServers } from "../../../shared/mcp.ts";
import { loadMcpTokens, mcpTokensFor, updateAgent } from "../../data/agents.ts";
import { servers as serverRows } from "../../data/mcp.ts";
import { commas, showAll, tokensText } from "../../lib/format.ts";
import { configMcpHref, MCP_HREF } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Fold } from "../../ui/Fold.tsx";
import {
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { serverLine, serverMeta } from "../directory/Directory.model.ts";
import {
  cardBody,
  isModeValue,
  MCP_LINE,
  MODE_HINT,
  MODE_OPTIONS,
  mcpSwitchLine,
  promptPreview,
  widest,
} from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import { whereOn, whereOnCount } from "./Mcp.model.ts";

// the tools a server gives on its own switches, the most any project gets
const toolCount = (server: McpServerSummary) =>
  offeredServers([server], widest([server]))[0]?.tools.length ?? 0;

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
      <McpSwitch agent={agent} drafts={d} />
      {takesTools && <Schemas agent={agent} drafts={d} />}
      {agent.mcp && <Servers agent={agent} takesTools={takesTools} />}
    </>
  );
}

function McpSwitch({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  const save = useSave(() =>
    d.save(async () => {
      const saved = await updateAgent(
        latest.current.id,
        cardBody(latest.current, { mcp: d.mcp.value }, loadedRows()),
      );
      d.resetMcp(saved);
    }),
  );
  const on = d.mcp.value;
  return (
    <SettingForm save={save}>
      <Setting
        title="MCP"
        line={mcpSwitchLine(on)}
        action={
          <RowsSwitch
            on={on}
            label="MCP"
            name="mcp"
            disabled={save.busy}
            onClick={() => {
              d.mcp.value = !on;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            locked={d.saving.value}
            save={save}
            dirty={d.mcpDirty(agent)}
            onDiscard={() => d.resetMcp(latest.current)}
          />
        }
      />
    </SettingForm>
  );
}

// every server, read only: the project chooses, so the rows say where
// each is on and link to the server's page
function Servers({
  agent,
  takesTools,
}: {
  agent: AgentSummary;
  takesTools: boolean;
}) {
  const all = serverRows.value;
  const now = useNow(60_000);
  const counted = mcpTokensFor(agent.id);
  const tokensOf = (id: string) =>
    counted?.servers.find((s) => s.id === id)?.tokens;
  const rows = byName(all ?? []);
  return (
    <Setting
      list
      title="MCP Servers"
      count={all === null || !takesTools ? undefined : String(rows.length)}
      line={MCP_LINE}
    >
      {all === null ? (
        <RowsNote>The servers did not load. Reload the page.</RowsNote>
      ) : !takesTools ? (
        <RowsNote>This model takes no tools.</RowsNote>
      ) : rows.length === 0 ? (
        <RowsNote>
          No MCP Servers yet. <a href={MCP_HREF}>Add one</a> and it shows here.
        </RowsNote>
      ) : (
        rows.map((server) => {
          const line = serverLine(server, now);
          const tokens = tokensOf(server.id);
          return (
            <RowsGo key={server.id} href={configMcpHref(server.name)}>
              <RowsTitle
                name={server.name}
                // the counts, their names on hover
                sub={
                  <>
                    {`${line.text} · `}
                    <span title={whereOn(server.on)}>
                      {whereOnCount(server.on)}
                    </span>
                  </>
                }
                bad={line.bad}
                mono
              />
              <RowsMeta
                keep
                under={tokens === undefined ? undefined : tokensText(tokens)}
              >
                {serverMeta({ tools: toolCount(server) })}
              </RowsMeta>
            </RowsGo>
          );
        })
      )}
    </Setting>
  );
}

function Schemas({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  const save = useSave(() =>
    d.save(async () => {
      const saved = await updateAgent(
        latest.current.id,
        cardBody(latest.current, { mcpMode: d.mode.value }, loadedRows()),
      );
      d.resetMode(saved);
      // each server's tokens are counted in the mode
      void loadMcpTokens(saved.id);
    }),
  );
  const preview = agent.mcp ? promptPreview(serverRows.value ?? []) : null;
  return (
    <SettingForm save={save}>
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
        {preview !== null &&
          (preview.text !== "" || preview.warnings.length > 0) && (
            <Instructions preview={preview} />
          )}
      </Setting>
    </SettingForm>
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
