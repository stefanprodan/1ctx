// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools, in two tabs. Built-in: every tool the server writes
// itself, webfetch and websearch included, read-only, each with its
// tokens. Limits: the caps a turn, a call, the knowledge base and
// scheduled tasks run under. Web access and Visuals have their own
// pages, their limits with them. The tab is the address, and the two
// routes name this one view, so a tab change keeps the page and its
// load. A change applies to the next send.

import { useSignal } from "@preact/signals";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import { path } from "../../app/router.ts";
import { limits, tools, toolsError } from "../../data/tools.ts";
import { tokensText } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import { Rows, RowsCard } from "../../ui/Rows.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { LimitsCard } from "./LimitsCard.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { TOOLS_TABS, toolsTab, totalTokens } from "./Tools.model.ts";
import { WEB_LIMITS } from "./WebAccess.model.ts";
import "./tools.css";
import { zoneStep } from "../../app/zones.ts";

// one card of rows, one open at a time, the schemas' tokens together
// in its head
function ToolsCard({
  label,
  rows,
}: {
  label: string;
  rows: (BuiltinToolSummary | WebToolSummary)[];
}) {
  const open = useSignal<string | null>(null);
  return (
    <RowsCard label={label} hint={tokensText(totalTokens(rows))}>
      {rows.map((tool) => (
        <ToolRow
          key={tool.name}
          tool={tool}
          open={open.value === tool.name}
          onToggle={() => {
            open.value = open.value === tool.name ? null : tool.name;
          }}
        />
      ))}
    </RowsCard>
  );
}

export function Tools() {
  const state = tools.value;
  const rows = limits.value;
  const tab = toolsTab(path.value);
  const error = toolsError.value;
  const href = TOOLS_TABS.find((t) => t.tab === tab)!.href;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Tools"
      loading={(state === null || rows === null) && error === null}
      error={error}
    >
      <Rows>
        <Tabs
          tabs={TOOLS_TABS.map(({ label, href }) => ({ label, href }))}
          active={href}
        />
        {tab === "builtin" && state && (
          <ToolsCard label="Built-in tools" rows={state.builtin} />
        )}
        {tab === "limits" && rows && (
          <>
            <LimitsCard rows={rows} scope="send" title="Per turn" />
            <LimitsCard
              rows={rows}
              scope="call"
              omit={WEB_LIMITS}
              title="Per call"
            />
            <LimitsCard rows={rows} scope="knowledge" title="Knowledge" />
            <LimitsCard rows={rows} scope="runs" title="Scheduled tasks" />
            <LimitsCard rows={rows} scope="chats" title="Chats" />
          </>
        )}
      </Rows>
    </Page>
  );
}
