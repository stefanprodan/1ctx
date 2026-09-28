// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools pages' entities: the built-ins, web access with the search
// state, visualize, the limits and the usage asides, all admin's,
// loaded when a page that shows them is reached and dropped with the
// signed-in user. A write answers the server's rows, so what shows is
// what was saved; a change applies to the next send.

import { effect, signal } from "@preact/signals";
import type {
  LimitsResponse,
  PutLimitsRequest,
} from "../../shared/api/limits.ts";
import type {
  PatchToolRequest,
  ToolsResponse,
  VisualsUsageResponse,
  WebUsageResponse,
} from "../../shared/api/tools.ts";
import type { LimitRow } from "../../shared/contracts/limit.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const tools = signal<ToolsResponse | null>(null);
export const limits = signal<LimitRow[] | null>(null);
export const toolsError = signal<Failure | null>(null);
// the Visuals page's last 30 days; `usage` is null when the read failed
export const visualsUsage = signal<{
  usage: VisualsUsageResponse | null;
} | null>(null);
// the Web access page's last 30 days, the same way
export const webUsage = signal<{ usage: WebUsageResponse | null } | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  tools.value = null;
  limits.value = null;
  toolsError.value = null;
  visualsUsage.value = null;
  webUsage.value = null;
});

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word, a failure
// included, since a route arrival reloads and a write can land while a
// load is in flight
let turn = 0;

export async function loadTools(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  toolsError.value = null;
  try {
    const [t, l] = await Promise.all([
      api<ToolsResponse>("/api/tools"),
      api<LimitsResponse>("/api/limits"),
    ]);
    if (owner === forUser && turn === mine) {
      tools.value = t;
      limits.value = l.limits;
    }
  } catch (err) {
    if (owner === forUser && turn === mine) toolsError.value = failure(err);
  }
}

// a write answers the whole entity, so of two writes in flight only the
// later one started may land: an earlier answer arriving last would put
// back what the later write changed
let toolWrites = 0;
let limitWrites = 0;

// the rows an admin writes: web access, the search provider, visualize
export type PatchedTool = "web" | "websearch" | "visualize";

export async function patchTool(
  name: PatchedTool,
  body: PatchToolRequest,
): Promise<void> {
  const forUser = owner;
  const mine = ++toolWrites;
  const next = await api<ToolsResponse>(
    `/api/tools/${encodeURIComponent(name)}`,
    "PATCH",
    body,
  );
  turn++;
  if (owner === forUser && toolWrites === mine) tools.value = next;
}

export async function saveLimits(body: PutLimitsRequest): Promise<void> {
  const forUser = owner;
  const mine = ++limitWrites;
  const next = await api<LimitsResponse>("/api/limits", "PUT", body);
  turn++;
  if (owner === forUser && limitWrites === mine) limits.value = next.limits;
}

let usageTurn = 0;

export async function loadVisualsUsage(): Promise<void> {
  const forUser = owner;
  const mine = ++usageTurn;
  let usage: VisualsUsageResponse | null = null;
  try {
    usage = await api<VisualsUsageResponse>("/api/usage/visuals");
  } catch {}
  if (owner === forUser && usageTurn === mine) visualsUsage.value = { usage };
}

let webTurn = 0;

export async function loadWebUsage(): Promise<void> {
  const forUser = owner;
  const mine = ++webTurn;
  let usage: WebUsageResponse | null = null;
  try {
    usage = await api<WebUsageResponse>("/api/usage/web");
  } catch {}
  if (owner === forUser && webTurn === mine) webUsage.value = { usage };
}
