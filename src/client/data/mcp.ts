// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP servers entity: the admin's list with the mcp- key files the
// form may pick and when the rows were read, loaded when its page or
// the agents page is reached and dropped with the signed-in user, and
// the calls that change it. A write puts the server's row in the list,
// so what shows is what was saved; the agent form's preview is built
// from these rows, so it says when they were loaded.

import { effect, signal } from "@preact/signals";
import type {
  CreateMcpRequest,
  McpResponse,
  McpServerResponse,
  McpUsageAllResponse,
  McpUsageResponse,
  PatchMcpRequest,
} from "../../shared/api/mcp.ts";
import type { McpServerSummary } from "../../shared/contracts/mcp.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const servers = signal<McpServerSummary[] | null>(null);
export const serversError = signal<Failure | null>(null);
export const keys = signal<string[]>([]);
export const callTimeoutMs = signal<number | null>(null);
export const loadedAt = signal<number | null>(null);
// a server page's last 30 days, for the server it was read for, and
// every server's for the list; usage is null when the read failed
export const serverUsage = signal<{
  serverId: string;
  usage: McpUsageResponse | null;
} | null>(null);
export const allUsage = signal<{ usage: McpUsageAllResponse | null } | null>(
  null,
);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  servers.value = null;
  serversError.value = null;
  keys.value = [];
  callTimeoutMs.value = null;
  loadedAt.value = null;
  serverUsage.value = null;
  allUsage.value = null;
});

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the list

const byName = (rows: McpServerSummary[]) =>
  rows.slice().sort((a, b) => a.name.localeCompare(b.name));

export async function loadMcp(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  serversError.value = null;
  try {
    const body = await api<McpResponse>("/api/mcp");
    if (owner === forUser && turn === mine) {
      servers.value = byName(body.servers);
      keys.value = body.keys;
      callTimeoutMs.value = body.callTimeoutMs;
      loadedAt.value = body.loadedAt;
    }
  } catch (err) {
    if (owner === forUser && turn === mine) serversError.value = failure(err);
  }
}

function keep(answer: McpServerResponse): McpServerSummary {
  const { server } = answer;
  servers.value = byName([
    ...(servers.value ?? []).filter((s) => s.id !== server.id),
    server,
  ]);
  return server;
}

export async function addServer(
  body: CreateMcpRequest,
): Promise<McpServerSummary> {
  const forUser = owner;
  turn++;
  const answer = await api<McpServerResponse>("/api/mcp", "POST", body);
  if (owner !== forUser) return answer.server;
  turn++;
  return keep(answer);
}

export async function patchServer(
  id: string,
  body: PatchMcpRequest,
): Promise<McpServerSummary> {
  const forUser = owner;
  turn++;
  const answer = await api<McpServerResponse>(
    `/api/mcp/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  if (owner !== forUser) return answer.server;
  turn++;
  return keep(answer);
}

export async function refreshServer(id: string): Promise<McpServerSummary> {
  const forUser = owner;
  turn++;
  const answer = await api<McpServerResponse>(
    `/api/mcp/${encodeURIComponent(id)}/refresh`,
    "POST",
    {},
  );
  if (owner !== forUser) return answer.server;
  turn++;
  return keep(answer);
}

export async function deleteServer(id: string): Promise<void> {
  const forUser = owner;
  turn++;
  await api(`/api/mcp/${encodeURIComponent(id)}`, "DELETE");
  if (owner === forUser) {
    turn++;
    servers.value = (servers.value ?? []).filter((s) => s.id !== id);
  }
}

// a failure is the aside's "Did not load", never the page's; only the
// latest read lands, so a switch between servers keeps the last one
let usageTurn = 0;

export async function loadServerUsage(id: string): Promise<void> {
  const forUser = owner;
  const mine = ++usageTurn;
  let usage: McpUsageResponse | null = null;
  try {
    usage = await api<McpUsageResponse>(
      `/api/mcp/${encodeURIComponent(id)}/usage`,
    );
  } catch {}
  if (owner === forUser && usageTurn === mine) {
    serverUsage.value = { serverId: id, usage };
  }
}

let allTurn = 0;

export async function loadAllUsage(): Promise<void> {
  const forUser = owner;
  const mine = ++allTurn;
  let usage: McpUsageAllResponse | null = null;
  try {
    usage = await api<McpUsageAllResponse>("/api/mcp/usage");
  } catch {}
  if (owner === forUser && allTurn === mine) allUsage.value = { usage };
}
