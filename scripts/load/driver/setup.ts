// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Readies a provisioned instance for the hour: the send caps at their
// defaults, the automations (owned by the admin, who sees every team
// project; extras suspended until a step needs them), and the team docs
// written through the API, since a chart's ConfigMap cannot carry them.
// What is already there by name is kept.

import type { AutomationResponse } from "../../../src/shared/api/automations.ts";
import type { KnowledgeListResponse } from "../../../src/shared/api/knowledge.ts";
import { knowledgeName, knowledgeText } from "../knowledge.ts";
import type { Api, Who } from "./api.ts";
import {
  instructions,
  planAutomations,
  setCaps,
  teamAutomations,
} from "./automations.ts";
import type { Directory } from "./directory.ts";
import { failure, info, now, pool } from "./log.ts";

export type SetupOptions = { maxMult: number; docs: number; parallel: number };

export async function setup(
  api: Api,
  admin: Who,
  d: Directory,
  o: SetupOptions,
) {
  await setCaps(api, admin, "default", 0);
  const t0 = now();
  const plan = planAutomations(d, o.maxMult);
  const have = await teamAutomations(api, admin, d);
  let created = 0;
  let skipped = 0;
  await pool(plan, o.parallel, async (a) => {
    const held = have.get(`${a.team.id}/${a.name}`);
    if (held) {
      skipped++;
      return;
    }
    const agent = d.agents[(a.index - 1) % d.agents.length]!;
    const minute = a.index % 60;
    const path = `/api/projects/${a.team.id}/automations`;
    const r = await api.call<AutomationResponse>(admin, "POST", path, {
      name: a.name,
      agentId: agent.id,
      instructions: instructions(a.index, a.hourly),
      // a placeholder time for the dailies: each step sets the real one
      schedule: a.hourly
        ? `${minute} * * * *`
        : `${minute} ${(a.index * 7) % 24} * * *`,
      tz: "UTC",
      deadlineMs: null,
      retentionDays: 30,
      ownMemory: false,
    });
    if (r.status !== 201) {
      failure("create automation", {
        name: a.name,
        status: r.status,
        error: r.error,
      });
      return;
    }
    created++;
    if (a.extra) {
      await api.call(
        admin,
        "POST",
        `/api/automations/${r.body.automation.id}/suspend`,
      );
    }
  });
  info("automations", {
    planned: plan.length,
    hourly: plan.filter((a) => a.hourly).length,
    extras: plan.filter((a) => a.extra).length,
    maxMult: o.maxMult,
    created,
    skipped,
    ms: now() - t0,
  });

  const t1 = now();
  const texts = Array.from({ length: o.docs }, (_, i) => ({
    name: knowledgeName(i),
    text: knowledgeText(i),
  }));
  let written = 0;
  let present = 0;
  let failed = 0;
  for (const [p, team] of d.teams.entries()) {
    const path = `/api/projects/${team.id}/knowledge`;
    const list = await api.must<KnowledgeListResponse>(admin, "GET", path);
    const names = new Set(list.files.map((f) => f.name));
    const missing = texts.filter((doc) => !names.has(doc.name));
    present += texts.length - missing.length;
    await pool(missing, o.parallel, async (doc) => {
      const r = await api.call(admin, "POST", path, doc);
      if (r.status === 201) written++;
      else {
        failed++;
        failure("write doc", {
          team: team.name,
          name: doc.name,
          status: r.status,
          error: r.error,
        });
      }
    });
    if ((p + 1) % 10 === 0 || p === d.teams.length - 1) {
      info("docs", { teams: p + 1, written, present, failed, ms: now() - t1 });
    }
  }
}
