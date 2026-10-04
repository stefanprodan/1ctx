// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's objects: the one provider (the fake model), agents,
// admins and members, team and personal projects, the fake MCP servers
// with their tools, skills, the decider, and the automations.

import { SERVERS, toolDef } from "../catalog.ts";
import { int, pick, rng, weighted } from "../random.ts";
import { FAKE, fakeMcpUrl } from "../shapes.ts";
import type { Build, User } from "./context.ts";
import { hash } from "./ids.ts";
import { DAY, HOUR, MIN, NO_PASSWORD, NOW } from "./presets.ts";
import { APPS, AREAS, hex, markdown, prose } from "./text.ts";
import { INSTRUCTIONS } from "./tools.ts";

const TZ = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "Asia/Singapore",
  "UTC",
];
const AGENT_NAMES = [
  "sre",
  "assistant",
  "writer",
  "reviewer",
  "oncall",
  "planner",
  "auditor",
  "analyst",
];
const CHECKS = [
  "deploy",
  "backup",
  "latency",
  "certs",
  "drift",
  "quota",
  "audit",
  "costs",
  "upgrades",
  "alerts",
];
export const SKILLS = ["gitops-guide", "incident-rca", "charts"];

const pad = (n: number, w: number) => String(n).padStart(w, "0");

// the one provider: every agent and the decider are on the fake model
export function provider(b: Build) {
  const { start } = b.clock;
  const p = b.provider;
  b.q.provider.run(p.id, p.name, p.wire, p.url, null, start);
}

export function agents(b: Build) {
  const { preset: P, clock } = b;
  const span = clock.historyDays * DAY;
  for (let a = 0; a < P.agents; a++) {
    const name =
      a < AGENT_NAMES.length
        ? AGENT_NAMES[a]!
        : `${APPS[a % APPS.length]}-${AGENT_NAMES[a % AGENT_NAMES.length]}`;
    // the last ones were retired over the history
    const first = P.agents - P.retiredAgents;
    const retiredAt =
      a >= first
        ? clock.start +
          Math.floor(((a - first + 1) / (P.retiredAgents + 1)) * span)
        : null;
    b.agents.push({
      id: b.newId(),
      name,
      provider: b.provider,
      model: FAKE.model,
      retiredAt,
      sre: a % 2 === 0 || name.includes("sre"),
    });
  }
  for (const [i, a] of b.agents.entries()) {
    b.q.agent.run(
      a.id,
      a.name,
      a.retiredAt === null ? a.provider.id : null,
      a.model,
      a.model,
      prose(rng(i), 400),
      clock.start,
      i === 0 ? 1 : 0,
      a.retiredAt,
    );
  }
  b.bump("agents", b.agents.length);
  b.liveAgents.push(...b.agents.filter((a) => a.retiredAt === null));
}

// an agent alive at t, an SRE one for an incident
export function agentAt(b: Build, r: () => number, t: number, sre = false) {
  const alive = b.agents.filter((a) => a.retiredAt === null || a.retiredAt > t);
  const fit = sre ? alive.filter((a) => a.sre) : alive;
  return pick(r, fit.length > 0 ? fit : alive);
}

export function people(b: Build) {
  const { preset: P, clock } = b;
  const PR = rng(0x9e0);
  for (let u = 0; u < P.admins + P.members; u++) {
    const admin = u < P.admins;
    const name = admin ? `adm${pad(u + 1, 2)}` : `u${pad(u - P.admins + 1, 3)}`;
    const choice = PR() < 0.3 ? Math.floor(PR() * b.liveAgents.length) : null;
    b.users.push({
      id: b.newId(),
      name,
      admin,
      teams: [],
      personal: "",
      pick: choice,
    });
  }
  for (const u of b.users) {
    const full = u.admin
      ? `Admin ${u.name.slice(3)}`
      : `User ${u.name.slice(1)}`;
    const agent = u.pick === null ? null : b.liveAgents[u.pick]!.id;
    const role = u.admin ? "admin" : "member";
    const email = `${u.name}@load.example`;
    const tz = pick(PR, TZ);
    b.q.user.run(
      u.id,
      u.name,
      full,
      email,
      role,
      NO_PASSWORD,
      clock.start,
      tz,
      agent,
    );
  }
  b.bump("users", b.users.length);

  for (let t = 0; t < P.teams; t++) {
    const area = AREAS[Math.floor(t / APPS.length) % AREAS.length];
    const extra = t >= APPS.length * AREAS.length ? `-${t}` : "";
    const name = `${APPS[t % APPS.length]}-${area}${extra}`;
    b.teams.push({ id: b.newId(), name, members: [] });
  }
  const devs = b.users.filter((u) => !u.admin);
  for (const u of devs) {
    const n = weighted(PR, [
      [2, 3],
      [3, 3],
      [4, 2],
      [5, 2],
    ] as const);
    while (u.teams.length < Math.min(n, b.teams.length)) {
      const t = Math.floor(PR() * b.teams.length);
      if (!u.teams.includes(t)) u.teams.push(t);
    }
    for (const t of u.teams) b.teams[t]!.members.push(u);
  }
  // every team has a few members to work with
  for (const [i, team] of b.teams.entries()) {
    while (team.members.length < Math.min(3, devs.length)) {
      const u = devs[(i * 7 + team.members.length * 13) % devs.length]!;
      if (team.members.includes(u)) {
        devs.push(devs.shift()!);
        continue;
      }
      team.members.push(u);
      u.teams.push(i);
    }
  }
  for (const [i, team] of b.teams.entries()) {
    const owner = team.members[0]!;
    const about = prose(rng(i + 77), 120);
    b.q.project.run(team.id, "team", team.name, about, owner.id, clock.start);
    for (const m of team.members) b.q.member.run(team.id, m.id, clock.start);
    b.bump("memberships", team.members.length);
  }
  for (const u of b.users) {
    u.personal = b.newId();
    b.q.project.run(u.personal, "personal", "personal", "", u.id, clock.start);
    // the owner is a member of their personal project, as the app makes it
    b.q.member.run(u.personal, u.id, clock.start);
  }
  b.bump("projects", b.teams.length + b.users.length);
}

export const teamsOf = (b: Build, u: User) =>
  u.admin ? b.teams.map((_, i) => i) : u.teams;

// the fake MCP servers on every live agent, cluster writable
export function servers(b: Build) {
  const { db, clock } = b;
  const insServer = db.query(
    `insert into mcp_servers (id, name, url, key_name, read, write, instructions_on, timeout_ms, read_patterns, write_patterns, excluded_patterns, server_name, server_version, protocol_version, instructions, fingerprint, checked_at, created_at) values (?, ?, ?, null, 1, ?, 1, null, '[]', '[]', '[]', ?, '1.0.0', '2025-06-18', ?, ?, ?, ?)`,
  );
  const insTool = db.query(
    `insert into mcp_tools (server_id, name, description, input_schema, unusable) values (?, ?, ?, ?, null)`,
  );
  const insLink = db.query(
    `insert into agent_servers (agent_id, server_id, read, write) values (?, ?, 1, ?)`,
  );
  for (const [si, server] of Object.values(SERVERS).entries()) {
    const id = b.newId();
    const write = server.name === "cluster" ? 1 : 0;
    const url = fakeMcpUrl(server.name);
    const print = hex(rng(si + 9), 64);
    insServer.run(
      id,
      server.name,
      url,
      write,
      `fake-${server.name}`,
      server.instructions,
      print,
      NOW - HOUR,
      clock.start,
    );
    for (const tool of server.tools) {
      const def = toolDef(server.name, tool);
      insTool.run(
        id,
        def.name,
        def.description,
        JSON.stringify(def.inputSchema),
      );
    }
    for (const a of b.liveAgents) insLink.run(a.id, id, write);
  }
}

export function skills(b: Build) {
  const { db, clock } = b;
  for (const [si, name] of SKILLS.entries()) {
    const id = b.newId();
    const body = markdown(rng(si + 500), 13_000);
    db.query(
      `insert into skills (id, name, description, body, license, compatibility, metadata, allowed_tools, source_kind, source_url, source_select, source_digest, digest, dropped, fetched_at, created_at) values (?, ?, ?, ?, 'Apache-2.0', '', '{}', '[]', 'github', ?, '', ?, ?, '[]', ?, ?)`,
    ).run(
      id,
      name,
      prose(rng(si), 200),
      body,
      `https://git.load.example/platform/skills/tree/main/${name}`,
      hex(rng(si + 1), 64),
      hex(rng(si + 2), 64),
      NOW - DAY,
      clock.start,
    );
    for (let f = 0; f < 4; f++) {
      const content = markdown(rng(si * 10 + f), 7400);
      db.query(
        `insert into skill_files (skill_id, path, content, bytes) values (?, ?, ?, ?)`,
      ).run(id, `references/${name}-${f}.md`, content, content.length);
    }
    for (const a of b.liveAgents.filter((x) => x.sre)) {
      db.query(
        `insert into agent_skills (agent_id, skill_id) values (?, ?)`,
      ).run(a.id, id);
    }
  }
}

export function decider(b: Build) {
  const { db, clock } = b;
  db.query(
    `insert into deciders (id, name, provider_id, model, context_length, prompt_price, is_default, created_at) values (?, 'fake-decider', ?, 'fake-decider', 32768, 0.05, 1, ?)`,
  ).run(b.decider, b.provider.id, clock.start);
  db.query(
    `insert into decisions (id, enabled, decider_id, updated_at) values ('run-attention', 1, ?, ?)`,
  ).run(b.decider, clock.start);
}

// 2 to 10 hourly automations a team; the running ones fired in the last
// minutes, a few are paused, some were deleted
export function automations(b: Build) {
  const { preset: P, teams, users } = b;
  const AR = rng(0xa070);
  const perTeam = teams.map(() => 2);
  for (let left = P.automations - 2 * teams.length; left > 0; ) {
    const t = Math.floor(AR() * teams.length);
    if (perTeam[t]! < 10) {
      perTeam[t]!++;
      left--;
    }
  }
  const list = b.automations;
  for (const [t, n] of perTeam.entries()) {
    for (let k = 0; k < n; k++) {
      const team = teams[t]!;
      list.push({
        id: b.newId(),
        index: list.length,
        team: t,
        owner: pick(AR, team.members),
        agent: pick(AR, b.liveAgents),
        name: `${CHECKS[k % CHECKS.length]} ${AR() < 0.25 ? "report" : "check"} ${team.name}`,
        instructions: pick(AR, INSTRUCTIONS),
        offset: 0,
        ownMemory: AR() < 0.6,
        running: false,
        stopAt: null,
        keepOrphans: false,
        suspendedBy: null,
        lastRun: null,
        lastFire: null,
      });
    }
  }
  const order = list.map((_, i) => i).sort((x, y) => hash(x, 1) - hash(y, 1));
  for (const [rank, i] of order.entries()) {
    const a = list[i]!;
    if (rank < P.runningRuns) {
      a.running = true;
      a.offset = (52 + (rank % 8)) * MIN + int(AR, 0, 59) * 1000;
    } else a.offset = int(AR, 0, 50) * MIN + int(AR, 0, 59) * 1000;
  }
  const paused = Math.max(1, Math.round(P.automations * 0.04));
  for (const i of order.slice(P.runningRuns, P.runningRuns + paused)) {
    const a = list[i]!;
    a.stopAt = NOW - int(AR, 1, 60) * DAY - int(AR, 0, 23) * HOUR;
    a.suspendedBy = AR() < 0.5 ? a.owner : users[int(AR, 0, P.admins - 1)]!;
  }
  for (let d = 0; d < P.deletedAutomations; d++) {
    const t = Math.floor(AR() * teams.length);
    list.push({
      id: null,
      index: list.length,
      team: t,
      owner: pick(AR, teams[t]!.members),
      agent: pick(AR, b.agents),
      name: `retired ${CHECKS[d % CHECKS.length]} check ${d}`,
      instructions: pick(AR, INSTRUCTIONS),
      offset: int(AR, 0, 50) * MIN,
      ownMemory: false,
      running: false,
      stopAt: NOW - int(AR, 5, Math.min(360, b.clock.historyDays - 1)) * DAY,
      keepOrphans: d % 2 === 0,
      suspendedBy: null,
      lastRun: null,
      lastFire: null,
    });
  }
}
