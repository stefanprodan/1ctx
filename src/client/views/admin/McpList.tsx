// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { allUsage, keys, servers, serversError } from "../../data/mcp.ts";
import { ago, count, pluralCommas } from "../../lib/format.ts";
import { configMcpHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { byName, useListSearch } from "../../lib/search.ts";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { KeyFilesSection, TopSection, UsageSection } from "./AdminAside.tsx";
import { sidesLine, usersOf } from "./Mcp.model.ts";
import { NewMcpServer } from "./NewMcpServer.tsx";
import "./mcp-page.css";

export function McpList() {
  if (new URLSearchParams(query.value).has("new")) return <NewMcpServer />;
  return <List />;
}

function List() {
  const rows = servers.value;
  const now = useNow(60_000);
  const all = byName(rows ?? []);
  const {
    q,
    shown,
    count: shownCount,
  } = useListSearch(all, (s) => [s.name, s.url, s.serverName]);
  const error = serversError.value ?? agentsError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="MCP Servers"
      split
      actions={<PageNew href="/admin/config/mcp?new" label="New server" />}
      loading={(rows === null || agents.value === null) && error === null}
      error={error}
    >
      <Split aside={<Aside list={all} />}>
        <Rows>
          <RowsCard
            label="MCP servers"
            search={<Search query={q} placeholder="Search servers" />}
            count={shownCount}
          >
            {all.length === 0 && (
              <RowsNote>
                No MCP servers yet. New server takes a URL and lists its tools.
              </RowsNote>
            )}
            {all.length > 0 && shown.length === 0 && (
              <RowsNote>No server matches.</RowsNote>
            )}
            {shown.map((s) => (
              <Row key={s.id} server={s} now={now} />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}

function Row({ server, now }: { server: McpServerSummary; now: number }) {
  const users = usersOf(agents.value ?? [], server.id).length;
  const failed =
    server.refreshFailedAt !== null && server.refreshError !== null;
  return (
    <RowsGo href={configMcpHref(server.name)}>
      <RowsTitle
        mono
        name={server.name}
        sub={
          failed
            ? `refresh failed ${ago(server.refreshFailedAt!, now)}`
            : server.url
        }
        bad={failed}
      />
      <RowsMeta keep under={sidesLine(server)}>
        {users === 0 ? "No agents" : pluralCommas(users, "agent", "agents")}
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ list }: { list: McpServerSummary[] }) {
  const usage = allUsage.value();
  const live = new Set(list.map((s) => s.name));
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
        rows={(usage?.servers ?? []).map((s) => ({
          name: s.name,
          value: s.calls,
          href: live.has(s.name) ? configMcpHref(s.name) : undefined,
        }))}
      />
      <KeyFilesSection
        files={keys.value}
        reader={(file) => {
          const user = list.find((s) => s.keyName === file);
          return user
            ? { label: user.name, href: configMcpHref(user.name) }
            : { label: "unused", quiet: true };
        }}
      />
    </>
  );
}
