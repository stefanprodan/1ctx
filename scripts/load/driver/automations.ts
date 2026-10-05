// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The hour's automations: five a team project (one hourly, four daily)
// and, past what those can hold at a high step, extra dailies spread
// over the teams up to the per-project cap. The tag in the instructions
// picks the fake model's run shape. And the send caps a step sets.

import type { AutomationsResponse } from "../../../src/shared/api/automations.ts";
import type { LimitsResponse } from "../../../src/shared/api/limits.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { HOUR } from "../shapes.ts";
import type { Api, Who } from "./api.ts";
import type { Directory, Team } from "./directory.ts";
import { now, out, pool } from "./log.ts";
import { CHECKS } from "./texts.ts";

const pad = (n: number, w: number) => String(n).padStart(w, "0");
export const autoName = (index: number) => `auto-${pad(index, 3)}`;
const extraName = (index: number) => `extra-${pad(index, 4)}`;

export const instructions = (index: number, hourly: boolean) =>
  `[run] ${hourly ? "[hourly]" : "[daily]"} #run-${index} ${CHECKS[index % CHECKS.length]}`;

// the dailies a step needs over its minutes: the burst and those later
export const dailyNeeded = (mult: number) =>
  HOUR.burst * mult +
  Math.round((HOUR.laterPerHour * mult * HOUR.stepMinutes) / 60);

export type Planned = {
  team: Team;
  name: string;
  index: number;
  hourly: boolean;
  extra: boolean;
};

export function planAutomations(d: Directory, maxMult: number): Planned[] {
  const per = HOUR.automationsPerTeam;
  const list: Planned[] = [];
  d.teams.forEach((team, p) => {
    for (let k = 0; k < per; k++) {
      const index = p * per + k + 1;
      list.push({
        team,
        name: autoName(index),
        index,
        hourly: k === 0,
        extra: false,
      });
    }
  });
  const base = d.teams.length * (per - 1);
  const room = d.teams.length * (HOUR.maxPerProject - per);
  const extras = Math.min(room, Math.max(0, dailyNeeded(maxMult) - base));
  for (let j = 0; j < extras; j++) {
    const index = d.teams.length * per + j + 1;
    const team = d.teams[j % d.teams.length]!;
    list.push({
      team,
      name: extraName(j + 1),
      index,
      hourly: false,
      extra: true,
    });
  }
  return list;
}

export async function teamAutomations(api: Api, admin: Who, d: Directory) {
  const byName = new Map<string, AutomationSummary>();
  await pool(d.teams, 4, async (team) => {
    const path = `/api/projects/${team.id}/automations`;
    const r = await api.must<AutomationsResponse>(admin, "GET", path);
    for (const a of r.automations) byName.set(`${team.id}/${a.name}`, a);
  });
  return byName;
}

export type CapsMode = "default" | "max";

// --caps as given: absent, or one of the two modes
export function parseCaps(value: string | undefined): CapsMode | undefined {
  if (value === undefined || value === "default" || value === "max")
    return value;
  throw new Error("--caps is default or max");
}

// the defaults at 1x and 2x, where what the scheduler does past a cap
// is the finding; the maximums from 4x on, so the machine shows; --caps
// holds one mode at every step
export const capsMode = (mult: number, given?: CapsMode): CapsMode =>
  given ?? (mult >= HOUR.maxCapsFrom ? "max" : "default");

export async function setCaps(
  api: Api,
  admin: Who,
  mode: CapsMode,
  step: number,
) {
  const limits = await api.must<LimitsResponse>(admin, "GET", "/api/limits");
  const names = ["sendsPerUser", "sendsPerProject", "sendsRunning"] as const;
  const values: Record<string, number> = {};
  for (const name of names) {
    const row = limits.limits.find((l) => l.name === name)!;
    values[name] = mode === "max" ? row.max : row.default;
  }
  await api.must<LimitsResponse>(admin, "PUT", "/api/limits", { values });
  out({ t: "caps", at: now(), step, mode, ...values });
}
