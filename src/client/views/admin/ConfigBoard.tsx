// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ToolsResponse } from "../../../shared/api/tools.ts";
import { path } from "../../app/router.ts";
import { agents } from "../../data/agents.ts";
import { credentials } from "../../data/credentials.ts";
import { deciders } from "../../data/deciders.ts";
import { servers } from "../../data/mcp.ts";
import { providers } from "../../data/providers.ts";
import { skills } from "../../data/skills.ts";
import { limits, tools, toolsError } from "../../data/tools.ts";
import { tokensText } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import { RowsCard } from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import {
  builtinsOf,
  CONFIG_TABS,
  configTab,
  instanceLines,
  LIMITS_CARDS,
  type LimitsGroup,
  offered,
  STORAGE_CARDS,
} from "./Config.model.ts";
import { LimitsSetting } from "./LimitsSetting.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { totalTokens } from "./Tools.model.ts";
import "./config-board.css";

export function ConfigBoard() {
  const state = tools.value;
  const rows = limits.value;
  const tab = configTab(path.value);
  const error = toolsError.value;
  // drawn on every tab, so a draft outlives a look at another
  const cards = (groups: readonly LimitsGroup[], shown: boolean) =>
    rows && (
      <div class={`config-board-cards${shown ? "" : " config-board-away"}`}>
        {groups.map((g) => (
          <LimitsSetting
            key={g.title}
            rows={rows}
            names={g.names}
            title={g.title}
            line={g.line}
          />
        ))}
      </div>
    );
  return (
    <Page
      crumb=""
      title="Config"
      split
      actions={
        tab === "storage" ? (
          <a class="btn btn-small" href="/admin/monitor/storage">
            Disk use
          </a>
        ) : undefined
      }
      loading={(state === null || rows === null) && error === null}
      error={error}
    >
      {state && rows && (
        <Split aside={<Aside state={state} />}>
          <div class="config-board">
            <Tabs
              tabs={CONFIG_TABS}
              active={CONFIG_TABS.find((t) => t.tab === tab)!.href}
            />
            {tab === "overview" && <Builtins state={state} />}
            {cards(LIMITS_CARDS, tab === "limits")}
            {cards(STORAGE_CARDS, tab === "storage")}
          </div>
        </Split>
      )}
    </Page>
  );
}

function Builtins({ state }: { state: ToolsResponse }) {
  const open = useSignal<string | null>(null);
  const rows = builtinsOf(state);
  return (
    <RowsCard label="Built-in tools" hint={tokensText(totalTokens(rows))}>
      {rows.map((tool) => (
        <ToolRow
          key={tool.name}
          tool={tool}
          offered={offered(tool, state)}
          open={open.value === tool.name}
          onToggle={() => {
            open.value = open.value === tool.name ? null : tool.name;
          }}
        />
      ))}
    </RowsCard>
  );
}

function Aside({ state }: { state: ToolsResponse }) {
  const lines = instanceLines(state, {
    providers: providers.value,
    agents: agents.value,
    deciders: deciders.value,
    servers: servers.value,
    skills: skills.value,
    credentials: credentials.value,
  });
  return (
    <AsideSection label="Instance">
      {lines.map((line) => (
        <AsideLine
          key={line.label}
          label={line.label}
          href={line.href}
          quiet={line.quiet}
        >
          {line.value}
        </AsideLine>
      ))}
    </AsideSection>
  );
}
