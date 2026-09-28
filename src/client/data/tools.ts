// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { instanceSlot } from "./slot.ts";

export const tools = signal<ToolsResponse | null>(null);
export const limits = signal<LimitRow[] | null>(null);
export const toolsError = signal<Failure | null>(null);
export const visualsUsage =
  instanceSlot<VisualsUsageResponse>("/api/usage/visuals");
export const webUsage = instanceSlot<WebUsageResponse>("/api/usage/web");
export const loadVisualsUsage = visualsUsage.load;
export const loadWebUsage = webUsage.load;

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  tools.value = null;
  limits.value = null;
  toolsError.value = null;
});

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

// a write answers the whole entity: of two in flight only the later may
// land, or an earlier answer arriving last puts back what the later
// changed
let toolWrites = 0;
let limitWrites = 0;

type PatchedTool = "web" | "websearch" | "visualize";

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
