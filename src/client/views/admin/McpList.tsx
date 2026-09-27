// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › MCP Servers: a list of links, one row per server in name
// order, the name over the URL, or over the failed refresh in red; at
// the right the agents that use it over what its sides offer. The
// card's head searches and counts, New server is in the page's head.
// The aside has every server's calls over the last 30 days and the key
// files, each with the server that reads it. `?new` is New server.

import { useSignal } from "@preact/signals";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import { classify } from "../../../shared/mcp.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { allUsage, keys, servers, serversError } from "../../data/mcp.ts";
import { ago, count, pluralCommas } from "../../lib/format.ts";
import { configMcpHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { byName, matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { NewMcpServer } from "./NewMcpServer.tsx";
import "./mcp-page.css";

export function McpList() {
  if (new URLSearchParams(query.value).has("new")) return <NewMcpServer />;
  return <List />;
}

// what the sides offer: a count per side switched on, "off" for the
// other, so the row says what an agent can be given
export function sidesLine(server: McpServerSummary): string {
  const sides = classify(server.name, server.tools, {
    read: server.readPatterns,
    write: server.writePatterns,
    excluded: server.excludedPatterns,
  });
  let read = 0;
  let write = 0;
  for (const side of sides.values()) {
    if (side === "read") read++;
    else if (side === "write") write++;
  }
  return [
    server.read ? `${read} read` : "read off",
    server.write ? `${write} write` : "write off",
  ].join(" · ");
}

function List() {
  const rows = servers.value;
  const q = useSignal("");
  const now = useNow(60_000);
  const all = byName(rows ?? []);
  const shown = all.filter((s) =>
    matches(q.value, [s.name, s.url, s.serverName]),
  );
  const error = serversError.value ?? agentsError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="MCP Servers"
      split
      actions={
        <a class="btn btn-small" href="/config/mcp?new">
          <Icon name="plus" size={14} />
          New server
        </a>
      }
      loading={(rows === null || agents.value === null) && error === null}
      error={error}
    >
      <Split aside={<Aside list={all} />}>
        <Rows>
          <RowsCard
            label="MCP servers"
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search servers"
              />
            }
            count={
              all.length === 0
                ? undefined
                : shown.length !== all.length
                  ? `${shown.length} of ${all.length}`
                  : String(all.length)
            }
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
  const users = (agents.value ?? []).filter((a) =>
    a.servers.some((s) => s.serverId === server.id),
  ).length;
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
      <RowsMeta keep>
        <span class="mcp-page-list-meta">
          <span>
            {users === 0 ? "No agents" : pluralCommas(users, "agent", "agents")}
          </span>
          <span class="mcp-page-list-sides">{sidesLine(server)}</span>
        </span>
      </RowsMeta>
    </RowsGo>
  );
}

// the most called servers the aside names
const TOP_SERVERS = 5;

function Aside({ list }: { list: McpServerSummary[] }) {
  const known = allUsage.value;
  const usage = known?.usage ?? null;
  const files = [...keys.value].sort((a, b) => a.localeCompare(b));
  const top = usage?.servers.slice(0, TOP_SERVERS) ?? [];
  const live = new Set(list.map((s) => s.name));
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
          {top.map((s) => (
            <AsideLine
              key={s.name}
              label={s.name}
              cut
              href={live.has(s.name) ? configMcpHref(s.name) : undefined}
            >
              {count(s.calls)}
            </AsideLine>
          ))}
        </AsideSection>
      )}
      <AsideSection label="Key files">
        {files.length === 0 ? (
          <p class="split-empty">None in the secrets directory.</p>
        ) : (
          files.map((file) => {
            const user = list.find((s) => s.keyName === file);
            return (
              <AsideLine
                key={file}
                label={`${file}.key`}
                cut
                href={user ? configMcpHref(user.name) : undefined}
                quiet={user === undefined}
              >
                {user?.name ?? "unused"}
              </AsideLine>
            );
          })
        )}
      </AsideSection>
    </>
  );
}
