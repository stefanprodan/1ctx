// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server's page under Config: the crumb is the head, its own
// step the switcher to the other servers; the failed refresh over the
// tabs when there is one; then General and Tools, one view for the two
// so the drafts outlive a tab switch. The aside has the server's last
// 30 days and its most called tools.

import { useRef } from "preact/hooks";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import {
  patchServer,
  servers,
  serversError,
  serverUsage,
} from "../../data/mcp.ts";
import { ago, count, plural, sentence } from "../../lib/format.ts";
import { configMcpHref, type McpTab } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { type Save, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Page } from "../../ui/Page.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { mcpFieldOf } from "./Mcp.model.ts";
import { McpGeneral } from "./McpGeneral.tsx";
import { McpDrafts } from "./McpPage.state.ts";
import { McpTools } from "./McpTools.tsx";
import "./mcp-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "MCP Servers", href: "/config/mcp" },
];

// the step after the name, so a server named tools opens on General
export function mcpTabOf(pathname: string): McpTab {
  return pathname.split("/")[4] === "tools" ? "tools" : "general";
}

// the most called tools the aside names
const TOP_TOOLS = 5;

export function McpPage({ params }: { params: Params }) {
  const list = servers.value;
  const server = list?.find((s) => s.name === params.name) ?? null;
  // Used by and Delete name the agents too, so the page waits for them
  const error = serversError.value ?? agentsError.value;
  const drafts = useRef<McpDrafts | null>(null);
  const row = useRef<McpServerSummary | null>(null);
  if (server !== null && drafts.current?.serverId !== server.id) {
    drafts.current = McpDrafts.of(server);
  } else if (
    server !== null &&
    row.current !== null &&
    row.current !== server
  ) {
    drafts.current?.follow(row.current, server);
  }
  row.current = server;
  const tab = mcpTabOf(path.value);
  // the Tools draft's save, held by the page so a tab switch keeps its
  // state; the row and drafts are read when it runs
  const toolsSave = useSave(async () => {
    const s = row.current;
    const d = drafts.current;
    if (s === null || d === null) return;
    const p = d.patterns.value;
    d.resetTools(
      await patchServer(s.id, {
        readPatterns: p.read,
        writePatterns: p.write,
        excludedPatterns: p.excluded,
      }),
    );
  }, mcpFieldOf);
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={
        server !== null ? <Switcher server={server} tab={tab} /> : undefined
      }
      split
      loading={(list === null || agents.value === null) && error === null}
      empty={
        list !== null && server === null
          ? "No MCP server by that name."
          : undefined
      }
      error={error}
    >
      {server !== null && drafts.current !== null && (
        <Split aside={<Aside server={server} />}>
          <Body
            key={server.id}
            server={server}
            tab={tab}
            drafts={drafts.current}
            toolsSave={toolsSave}
          />
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other servers, by name, a pick opening its
// page on the same tab
function Switcher({ server, tab }: { server: McpServerSummary; tab: McpTab }) {
  const list = byName(servers.value ?? []);
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{server.name}</span>;
  }
  return (
    <Finder
      label="MCP servers"
      triggerClass="page-pill"
      title={server.name}
      trigger={
        <>
          <span class="cut">{server.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((s) => ({
        value: s.id,
        label: s.name,
        href: configMcpHref(s.name, tab),
      }))}
      value={server.id}
      mono
      wide
      placeholder="Find a server"
      none="No server matches"
    />
  );
}

function Body({
  server,
  tab,
  drafts,
  toolsSave,
}: {
  server: McpServerSummary;
  tab: McpTab;
  drafts: McpDrafts;
  toolsSave: Save;
}) {
  const now = useNow(60_000);
  const failed =
    server.refreshError !== null && server.refreshFailedAt !== null;
  return (
    <div class="mcp-page">
      {failed && (
        <p class="mcp-page-bad" role="status">
          <Icon name="alert" size={16} class="mcp-page-bad-icon" />
          {`Refresh failed ${ago(server.refreshFailedAt!, now)}: ${sentence(
            server.refreshError!,
          )} Agents are still offered the ${plural(
            server.tools.length,
            "tool",
          )} listed ${ago(server.checkedAt, now)}, and their calls fail until the server answers.`}
        </p>
      )}
      <Tabs
        tabs={[
          { label: "General", href: configMcpHref(server.name) },
          {
            label: "Tools",
            href: configMcpHref(server.name, "tools"),
            count: server.tools.length,
          },
        ]}
        active={configMcpHref(server.name, tab)}
      />
      {tab === "general" && (
        <McpGeneral server={server} drafts={drafts} now={now} />
      )}
      {tab === "tools" && (
        <McpTools server={server} drafts={drafts} save={toolsSave} />
      )}
    </div>
  );
}

function Aside({ server }: { server: McpServerSummary }) {
  const known =
    serverUsage.value?.serverId === server.id ? serverUsage.value : null;
  const usage = known?.usage ?? null;
  const top = usage?.tools.slice(0, TOP_TOOLS) ?? [];
  return (
    <>
      <AsideSection label="Last 30 days">
        {known === null ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Calls">{count(usage.calls)}</AsideLine>
            <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          </>
        )}
      </AsideSection>
      {top.length > 0 && (
        <AsideSection label="Most called">
          {top.map((t) => (
            <AsideLine key={t.name} label={t.name} cut>
              {count(t.calls)}
            </AsideLine>
          ))}
        </AsideSection>
      )}
    </>
  );
}
