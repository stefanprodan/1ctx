// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP servers: one card of rows, each a server an admin registered.
// New server opens McpForm.tsx at the top. A row opens in place to the
// last change, the server's own words, the endpoint with its own
// Change button since it discovers first, the settings with Save, the
// tools in the four groups the fields give live, the instructions as
// the prompt carries them, then Refresh and Delete asked once in place.
// Everything the server wrote is shown as text; the parameters are the
// one HTML, rendered on the server.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { servers, serversError } from "../../data/mcp.ts";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import { Rows, RowsAdd, RowsCard, RowsNew, RowsNote } from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { McpForm } from "./McpForm.tsx";
import { ServerRow } from "./McpRow.tsx";
import "./mcp.css";

export function Mcp() {
  const list = servers.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const error = serversError.value;
  const q = useSignal("");
  const shown = (list ?? []).filter((server) =>
    matches(q.value, [server.name, server.url, server.serverName]),
  );
  // the ago words move by the minute
  const now = useSignal(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Page
      crumb="Admin"
      title="MCP"
      loading={list === null && error === null}
      error={error}
    >
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
          action={
            <RowsAdd
              label="New server"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            />
          }
        >
          {adding.value && (
            <RowsNew>
              <McpForm
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {list?.length === 0 && !adding.value && (
            <RowsNote>
              No MCP servers yet. New server takes a URL, lists its tools and
              keeps them.
            </RowsNote>
          )}
          {q.value.trim() !== "" && shown.length === 0 && (
            <RowsNote>No servers found</RowsNote>
          )}
          {shown.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              now={now.value}
              open={open.value === server.id}
              onToggle={() => {
                open.value = open.value === server.id ? null : server.id;
                adding.value = false;
              }}
            />
          ))}
        </RowsCard>
      </Rows>
    </Page>
  );
}
