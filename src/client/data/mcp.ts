// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { byName } from "../lib/search.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { instanceSlot, usageSlot } from "./slot.ts";

export const servers = signal<McpServerSummary[] | null>(null);
export const serversError = signal<Failure | null>(null);
export const keys = signal<string[]>([]);
export const callTimeoutMs = signal<number | null>(null);
export const loadedAt = signal<number | null>(null);
export const serverUsage = usageSlot<McpUsageResponse>(
  (id) => `/api/mcp/${encodeURIComponent(id)}/usage`,
);
export const loadServerUsage = serverUsage.load;
export const allUsage = instanceSlot<McpUsageAllResponse>("/api/mcp/usage");
export const loadAllUsage = allUsage.load;

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  servers.value = null;
  serversError.value = null;
  keys.value = [];
  callTimeoutMs.value = null;
  loadedAt.value = null;
});

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
