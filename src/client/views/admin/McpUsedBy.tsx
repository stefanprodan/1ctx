// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The last two cards of an MCP server's General tab: the agents that
// use it, each opening its MCP tab, and Delete, which waits until none
// does, since the server refuses a server an agent uses.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import { address, navigate } from "../../app/router.ts";
import { agents } from "../../data/agents.ts";
import { deleteServer } from "../../data/mcp.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { pluralCommas } from "../../lib/format.ts";
import { configAgentHref } from "../../lib/hrefs.ts";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { RowsAvatar, RowsGo, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { mcpFieldOf } from "./Mcp.model.ts";

export function UsedBy({ server }: { server: McpServerSummary }) {
  const users = byName(agents.value ?? []).filter((a) =>
    a.servers.some((s) => s.serverId === server.id),
  );
  // Delete's line says no agent uses it
  if (users.length === 0) return null;
  return (
    <Setting list title="Used by" count={String(users.length)}>
      {users.map((a) => {
        const link = a.servers.find((s) => s.serverId === server.id)!;
        return (
          <RowsGo key={a.id} href={configAgentHref(a.name, "mcp")}>
            <RowsAvatar>
              <AvatarIcon name={a.avatar} size={15} />
            </RowsAvatar>
            <RowsTitle
              mono
              name={`@${a.name}`}
              sub={link.write ? "Read and write" : "Read"}
            />
          </RowsGo>
        );
      })}
    </Setting>
  );
}

// the words over Delete: the agents that keep the server, or none
export function mcpDeleteLine(agentCount: number): string {
  if (agentCount === 0) return "No agent uses it.";
  return `${pluralCommas(agentCount, "agent uses", "agents use")} it. Remove it from ${
    agentCount === 1 ? "that agent" : "them"
  } first.`;
}

export function DeleteCard({ server }: { server: McpServerSummary }) {
  const asking = useSignal(false);
  const save = useSave(async () => {}, mcpFieldOf);
  const used = (agents.value ?? []).filter((a) =>
    a.servers.some((s) => s.serverId === server.id),
  ).length;
  // Escape takes the ask back
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking.value]);
  return (
    <Setting
      danger
      title={`Delete ${server.name}`}
      line={mcpDeleteLine(used)}
      foot={
        <Foot save={save}>
          <div class="mcp-page-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy || used > 0}
              words={`Delete ${server.name}?`}
              wordsClass="mcp-page-ask"
              // the list drops the server as the call ends, which takes
              // this card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  await deleteServer(server.id);
                  if (address() === from) navigate("/config/mcp");
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}
