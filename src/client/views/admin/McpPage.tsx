// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { count } from "../../lib/format.ts";
import { configMcpHref, type McpTab } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { type Save, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { SettingAlert, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { TopSection, UsageSection } from "./AdminAside.tsx";
import { useLatest, useRowDrafts } from "./drafts.ts";
import { mcpFieldOf } from "./Mcp.model.ts";
import { McpGeneral } from "./McpGeneral.tsx";
import { McpDrafts } from "./McpPage.state.ts";
import { McpTools } from "./McpTools.tsx";
import { refreshLine } from "./refresh.ts";
import "./mcp-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "MCP Servers", href: "/admin/config/mcp" },
];

// the step after the name, so a server named tools opens on General
export function mcpTabOf(pathname: string): McpTab {
  return pathname.split("/")[5] === "tools" ? "tools" : "general";
}

export function McpPage({ params }: { params: Params }) {
  const list = servers.value;
  const server = list?.find((s) => s.name === params.name) ?? null;
  // Used by and Delete name the agents too, so the page waits for them
  const error = serversError.value ?? agentsError.value;
  const drafts = useRowDrafts(server, McpDrafts.of, (d, before, after) =>
    d.follow(before, after),
  );
  const tab = mcpTabOf(path.value);
  // held by the page so a tab switch keeps its state; the row and the
  // drafts are read when it runs
  const latest = useLatest({ server, drafts });
  const toolsSave = useSave(async () => {
    const { server: s, drafts: d } = latest.current;
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
        server !== null ? (
          <PageSwitcher
            label="MCP servers"
            current={server.id}
            name={server.name}
            items={byName(list ?? []).map((s) => ({
              id: s.id,
              label: s.name,
              href: configMcpHref(s.name, tab),
            }))}
            placeholder="Find a server"
            none="No server matches"
          />
        ) : undefined
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
      {server !== null && drafts !== null && (
        <Split aside={<Aside server={server} />}>
          <Body
            key={server.id}
            server={server}
            tab={tab}
            drafts={drafts}
            toolsSave={toolsSave}
          />
        </Split>
      )}
    </Page>
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
  return (
    <SettingStack>
      {server.refreshError !== null && server.refreshFailedAt !== null && (
        <SettingAlert>
          {refreshLine(server.refreshError, server.refreshFailedAt, now)}
        </SettingAlert>
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
    </SettingStack>
  );
}

function Aside({ server }: { server: McpServerSummary }) {
  const usage = serverUsage.valueFor(server.id);
  return (
    <>
      <UsageSection value={usage}>
        {(u) => (
          <>
            <AsideLine label="Calls">{count(u.calls)}</AsideLine>
            <AsideLine label="Failed">{count(u.failed)}</AsideLine>
          </>
        )}
      </UsageSection>
      <TopSection
        label="Most called"
        rows={(usage?.tools ?? []).map((t) => ({
          name: t.name,
          value: t.calls,
        }))}
      />
    </>
  );
}
