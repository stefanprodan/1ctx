// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools page's entities: the built-ins with the search state, and
// the limits, both admin's, loaded when the page is reached and dropped
// with the signed-in user. A write answers the server's rows, so what
// shows is what was saved; a change applies to the next send.

import { effect, signal } from "@preact/signals";
import type {
  LimitsResponse,
  PutLimitsRequest,
} from "../../shared/api/limits.ts";
import type {
  PatchToolRequest,
  ToolsResponse,
} from "../../shared/api/tools.ts";
import type { LimitRow } from "../../shared/contracts/limit.ts";
import type { BuiltinTool } from "../../shared/words.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const tools = signal<ToolsResponse | null>(null);
export const limits = signal<LimitRow[] | null>(null);
export const toolsError = signal<Failure | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  tools.value = null;
  limits.value = null;
  toolsError.value = null;
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

export async function patchTool(
  name: BuiltinTool,
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

export async function resetLimits(): Promise<void> {
  const forUser = owner;
  const mine = ++limitWrites;
  await api("/api/limits", "DELETE");
  const next = await api<LimitsResponse>("/api/limits");
  turn++;
  if (owner === forUser && limitWrites === mine) limits.value = next.limits;
}
