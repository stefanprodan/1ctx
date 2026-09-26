// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools, in four tabs. Built-in: every tool the server writes
// itself, webfetch and websearch included, read-only, each with its
// tokens. Web: web access for the instance, the search provider, None
// first, one row per provider with whether its key file is there, and
// the HTTP credentials bash's curl signs with. Visuals, as settings
// sections: visualize with its own switch, apart from web access, the
// CDNs a visual may load from and its limits. Limits: the caps a turn,
// a call, the knowledge base and scheduled tasks run under. The tab is
// the address, and the four routes name this one view, so a tab change
// keeps the page and its load. A change applies to the next send.

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
import { credentialsError } from "../../data/credentials.ts";
import { limits, patchTool, tools, toolsError } from "../../data/tools.ts";
import { tokensText } from "../../lib/format.ts";
import { useAction } from "../../lib/save.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsNote,
  RowsRadio,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { CredentialsCard } from "./CredentialsCard.tsx";
import { LimitsCard } from "./LimitsCard.tsx";
import { LimitsSection } from "./LimitsSection.tsx";
import { ToolRow } from "./ToolRow.tsx";
import {
  keyLine,
  searchLine,
  TOOLS_TABS,
  toolsTab,
  totalTokens,
} from "./Tools.model.ts";
import { VisualHosts } from "./VisualHosts.tsx";
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

// the visualize row in an inset list beside what it gives, the switch
// at its end
function VisualTool({ tool }: { tool: WebToolSummary }) {
  const open = useSignal(false);
  return (
    <Section title="Tools" text="Inline visualizations">
      <RowsList>
        <ToolRow
          tool={tool}
          open={open.value}
          onToggle={() => {
            open.value = !open.value;
          }}
        />
      </RowsList>
    </Section>
  );
}

// the providers as radio rows; a pick writes at once
function SearchCard() {
  const state = tools.value?.search;
  const { busy, failure, run } = useAction();
  if (!state) return null;
  const choose = async (provider: SearchProvider | null) => {
    if (provider === state.provider || busy.value) return;
    await run(() => patchTool("websearch", { provider }));
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
  const tab = toolsTab(path.value);
  // the Web tab fails with the credentials too; their card waits alone,
  // so a tab change never blanks the page
  const error =
    toolsError.value ?? (tab === "web" ? credentialsError.value : null);
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
            <CredentialsCard />
          </>
        )}
        {tab === "visuals" && state && rows && (
          <div>
            <VisualTool tool={state.visualize} />
            <VisualHosts off={!state.visualize.enabled} />
            <LimitsSection
              rows={rows}
              scope="visuals"
              title="Limits"
              text="How much one turn may draw."
              off={!state.visualize.enabled}
            />
          </div>
        )}
        {tab === "limits" && rows && (
          <>
            <LimitsCard rows={rows} scope="send" title="Per turn" />
            <LimitsCard rows={rows} scope="call" title="Per call" />
            <LimitsCard rows={rows} scope="knowledge" title="Knowledge" />
            <LimitsCard rows={rows} scope="runs" title="Scheduled tasks" />
            <LimitsCard rows={rows} scope="chats" title="Chats" />
          </>
        )}
      </Rows>
    </Page>
  );
}
