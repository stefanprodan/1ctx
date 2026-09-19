// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools, in three tabs. Built-in: every tool the server writes
// itself, webfetch and websearch included, read-only, each with its
// tokens. Web: web access for the instance, the search provider, None
// first, one row per provider with whether its key file is there, and
// visualize with its own switch, apart from web access. Limits: the caps a send and a call
// run under. The tab is the address, and the three routes name this one
// view, so a tab change keeps the page and its load. A change applies to
// the next send.

import { useSignal } from "@preact/signals";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import {
  SEARCH_PROVIDERS,
  type SearchProvider,
} from "../../../shared/words.ts";
import { path } from "../../app/router.ts";
import { limits, patchTool, tools, toolsError } from "../../data/tools.ts";
import { says } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsLine,
  RowsMeta,
  RowsNote,
  RowsRadio,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { LimitsCard } from "./LimitsCard.tsx";
import { ToolRow } from "./ToolRow.tsx";
import {
  keyLine,
  searchLine,
  TOOLS_TABS,
  tokensText,
  toolsTab,
  totalTokens,
} from "./Tools.model.ts";
import { WebAccessCard } from "./WebAccessCard.tsx";
import "./tools.css";

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

// the providers as radio rows; a pick writes at once
function SearchCard() {
  const state = tools.value?.search;
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  if (!state) return null;
  const choose = async (provider: SearchProvider | null) => {
    if (provider === state.provider || busy.value) return;
    busy.value = true;
    failure.value = null;
    try {
      await patchTool("websearch", { provider });
    } catch (err) {
      failure.value = says(err);
    }
    busy.value = false;
  };
  return (
    <RowsCard label="Web search">
      <RowsLine as="label" flush>
        <RowsRadio
          name="search"
          value="none"
          checked={state.provider === null}
          disabled={busy.value}
          onChange={() => void choose(null)}
        />
        <RowsTitle name="None" mono />
      </RowsLine>
      {SEARCH_PROVIDERS.map((provider) => (
        <RowsLine key={provider} as="label" flush>
          <RowsRadio
            name="search"
            value={provider}
            checked={state.provider === provider}
            disabled={busy.value}
            onChange={() => void choose(provider)}
          />
          <RowsTitle name={provider} mono />
          <RowsMeta>{keyLine(provider, state.keys[provider])}</RowsMeta>
        </RowsLine>
      ))}
      <RowsNote>
        {failure.value ? (
          <span class="error">{failure.value}</span>
        ) : (
          searchLine(state, tools.value?.access.mode ?? "all")
        )}
      </RowsNote>
    </RowsCard>
  );
}

export function Tools() {
  const state = tools.value;
  const rows = limits.value;
  const error = toolsError.value;
  const tab = toolsTab(path.value);
  const href = TOOLS_TABS.find((t) => t.tab === tab)!.href;
  return (
    <Page
      crumb="Admin"
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
        {tab === "web" && state && (
          <>
            <WebAccessCard />
            <SearchCard />
            <ToolsCard label="Visuals" rows={[state.visualize]} />
          </>
        )}
        {tab === "limits" && rows && (
          <>
            <LimitsCard rows={rows} scope="send" title="Per send" />
            <LimitsCard rows={rows} scope="call" title="Per call" />
            <LimitsCard rows={rows} scope="knowledge" title="Knowledge" />
          </>
        )}
      </Rows>
    </Page>
  );
}
