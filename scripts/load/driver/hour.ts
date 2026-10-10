// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One step of the busiest hour at MULT times its counts, replaying its
// first minutes with the real scheduler: before the step every daily
// automation in play gets a time so the burst falls at its start, the
// hourly ones spread over the hour, the rest suspended. During the step
// chats start at the hour's rate as members of their projects and
// follow up after thinking, four devs keep the incident going, Run now
// covers the fires the automations cannot hold, and the watchers and
// the probe run beside. Then the tail, and the read back.

import type { AutomationResponse } from "../../../src/shared/api/automations.ts";
import { pick, type Rand, rng, shuffle } from "../random.ts";
import { HOUR } from "../shapes.ts";
import type { Api, Who } from "./api.ts";
import {
  type CapsMode,
  capsMode,
  type Planned,
  planAutomations,
  setCaps,
  teamAutomations,
} from "./automations.ts";
import { Poster } from "./chats.ts";
import { type Directory, signInAll } from "./directory.ts";
import { failure, info, MIN, now, out, pool, sleep, stats } from "./log.ts";
import { Monitor } from "./monitor.ts";
import { probe } from "./probe.ts";
import { readBack, type StepRecord } from "./readback.ts";
import { FOLLOWUPS, INCIDENT, QUESTIONS } from "./texts.ts";
import { Watcher, watch } from "./watchers.ts";

type ChatPlan = {
  n: number;
  at: number;
  user: string;
  project: string;
  agent: string;
  turns: number;
};

const between = (r: Rand, [a, b]: readonly number[]) => a! + r() * (b! - a!);

function turnsOf(r: Rand): number {
  let x = r();
  const w = HOUR.turnsPerChat;
  for (let i = 0; i < w.length; i++) {
    x -= w[i]!;
    if (x <= 0) return i + 1;
  }
  return w.length;
}

const cron = (at: number) => {
  const d = new Date(at);
  return `${d.getUTCMinutes()} ${d.getUTCHours()} * * *`;
};

export type StepOptions = {
  mult: number;
  minutes: number;
  seed: number;
  // every chat in the incident's shape
  incident: boolean;
  personal: string;
  // the send caps at every step, or by the step's multiple when absent
  caps?: CapsMode;
};

export async function step(api: Api, admin: Who, d: Directory, o: StepOptions) {
  const { mult, minutes } = o;
  const r = rng(o.seed);
  const prepAt = now();
  await setCaps(api, admin, capsMode(mult, o.caps), mult);

  const chatCount = Math.round((HOUR.chats * mult * minutes) / 60);
  // a Poisson process given its count: uniform order statistics
  const offsets = Array.from(
    { length: chatCount },
    () => r() * minutes * MIN,
  ).sort((a, b) => a - b);
  const chats: ChatPlan[] = offsets.map((at, i) => {
    const user = pick(r, d.members);
    return {
      n: mult * 10_000 + i + 1,
      at,
      user,
      project: pick(r, d.memberTeams.get(user)!),
      agent: pick(r, d.agents).id,
      turns: turnsOf(r),
    };
  });
  const big = d.teams.filter((t) => t.members.length >= HOUR.incidentUsers);
  const incidentTeam = pick(r, big.length > 0 ? big : d.teams);
  const incidentUsers = shuffle(r, incidentTeam.members).slice(
    0,
    HOUR.incidentUsers,
  );
  const incidentAgent = pick(r, d.agents).id;
  const watcherAdmins = d.admins.slice(0, HOUR.watcherAdmins);
  const watcherMembers = shuffle(r, d.members).slice(
    0,
    HOUR.watchers - watcherAdmins.length,
  );

  // the automations' times: every one setup may have made, at any step
  const plan = planAutomations(d, Number.MAX_SAFE_INTEGER);
  const rows = await teamAutomations(api, admin, d);
  const present = plan.filter((a) => rows.has(`${a.team.id}/${a.name}`));
  const hourly = present.filter((a) => a.hourly);
  const daily = [
    ...present.filter((a) => !a.hourly && !a.extra),
    ...present.filter((a) => a.extra),
  ];
  const baseCount = present.filter((a) => !a.hourly && !a.extra).length;
  const burstMin = Math.min(HOUR.burstMinutes, minutes);
  const burst = Math.round((HOUR.burst * mult * burstMin) / HOUR.burstMinutes);
  const later =
    minutes > burstMin
      ? Math.round((HOUR.laterPerHour * mult * minutes) / 60)
      : 0;
  const active = daily.slice(
    0,
    Math.max(baseCount, Math.min(daily.length, burst + later)),
  );
  const resting = daily.slice(active.length);
  // Run now covers what the automations cannot, by members of the team
  const shortBurst = Math.max(0, burst - active.length);
  const shortLater = Math.max(0, later - Math.max(0, active.length - burst));
  const pressers = new Map<string, string[]>();
  if (shortBurst + shortLater > 0) {
    for (const team of d.teams)
      pressers.set(team.id, shuffle(r, team.members).slice(0, 2));
  }
  const needed = new Set([
    ...watcherAdmins,
    ...watcherMembers,
    ...chats.map((c) => c.user),
    ...incidentUsers,
    ...[...pressers.values()].flat(),
  ]);
  const who = await signInAll(api, d, [...needed]);

  const monitor = new Monitor(api, admin);
  await monitor.open();
  const watchers = [
    ...watcherAdmins.map((u) => new Watcher(api, who.get(u)!, null, 0, r)),
    ...watcherMembers.map(
      (u, i) =>
        new Watcher(
          api,
          who.get(u)!,
          i % 2 === 0 ? null : pick(r, d.memberTeams.get(u)!),
          HOUR.lookShare,
          r,
        ),
    ),
  ];
  await pool(watchers, 8, (w) => w.connect());
  info("watchers open", {
    sockets: watchers.length,
    admins: watcherAdmins.length,
    feedInitial: stats(watch.feedInitial),
  });

  const patches = hourly.length + daily.length;
  // on a minute, past the patches with a margin: the scheduler wakes on
  // each schedule change, so it needs no lead of its own
  const T0 = Math.ceil((now() + patches * 40 + 30_000) / MIN) * MIN;
  const end = T0 + minutes * MIN;
  const due = new Map<string, number>();
  const slots: number[] = [];
  for (let k = 0; k < burst; k++) slots.push(T0 + (k % burstMin) * MIN);
  for (let l = 0; l < later; l++) {
    slots.push(
      T0 +
        (burstMin + Math.floor(((l + 0.5) * (minutes - burstMin)) / later)) *
          MIN,
    );
  }
  const ids = (a: Planned) => rows.get(`${a.team.id}/${a.name}`)!;
  const times = new Map<string, string>();
  active.forEach((a, i) => {
    // past the step's slots: spread over the rest of the day
    const rest = Math.max(1, active.length - slots.length);
    const at =
      i < slots.length
        ? slots[i]!
        : end +
          10 * MIN +
          Math.floor(((i - slots.length) * (24 * 60 - minutes - 20)) / rest) *
            MIN;
    times.set(ids(a).id, cron(at));
  });
  hourly.forEach((a, j) => {
    const minute =
      (new Date(T0).getUTCMinutes() + Math.floor((j * 60) / hourly.length)) %
      60;
    times.set(ids(a).id, `${minute} * * * *`);
  });
  const t1 = now();
  let patchErrors = 0;
  // flipping the zone makes every PATCH recompute next_at, which also
  // ends a wait a cap left from the last step
  const order = [...active.slice(0, burst), ...hourly, ...active.slice(burst)];
  await pool(order, 4, async (a) => {
    const row = ids(a);
    if (row.suspendedAt !== null)
      await api.call(admin, "POST", `/api/automations/${row.id}/resume`);
    const res = await api.call<AutomationResponse>(
      admin,
      "PATCH",
      `/api/automations/${row.id}`,
      {
        schedule: times.get(row.id),
        tz: row.tz === "UTC" ? "Etc/UTC" : "UTC",
        editRevision: row.editRevision,
      },
    );
    if (res.status !== 200) {
      patchErrors++;
      failure("patch automation", {
        name: a.name,
        status: res.status,
        error: res.error,
      });
      return;
    }
    const next = res.body.automation.nextAt;
    if (next !== null && next < end) due.set(row.id, next);
  });
  await pool(resting, 4, async (a) => {
    const row = ids(a);
    if (row.suspendedAt === null)
      await api.call(admin, "POST", `/api/automations/${row.id}/suspend`);
  });
  info("schedules set", {
    step: mult,
    t0: new Date(T0).toISOString(),
    patched: order.length,
    suspended: resting.length,
    errors: patchErrors,
    ms: now() - t1,
    burst,
    later,
    dueInStep: due.size,
    runNowBurst: shortBurst,
    runNowLater: shortLater,
    chats: chatCount,
    incident: incidentTeam.name,
  });
  if (now() > T0 - 10_000)
    info("late: schedules finished close to the step start", {
      behindMs: now() - T0,
    });
  for (const [id, at] of due) out({ t: "due", step: mult, automation: id, at });

  const poster = new Poster(api, mult);
  const pressedAt = new Map<string, number>();
  const incidentSessions: string[] = [];
  let ending = false;
  await sleep(T0 - now());
  out({ t: "step", n: mult, at: now(), phase: "start" });
  const lag: number[] = [];
  let tick = performance.now();
  const lagTimer = setInterval(() => {
    const t = performance.now();
    lag.push(Math.max(0, t - tick - 1000));
    tick = t;
  }, 1000);
  const pollTimer = setInterval(() => void monitor.poll(false), MIN);

  async function chat(c: ChatPlan) {
    const u = who.get(c.user)!;
    const prefix = o.incident ? "[incident] " : "";
    const started = await poster.start(
      u,
      c.project,
      c.agent,
      "chat",
      `chat-${c.n}`,
      `${prefix}${pick(r, QUESTIONS)}`,
    );
    if (started === null) return;
    let sendId = started.send;
    let prev: string | null = null;
    for (let k = 2; k <= c.turns; k++) {
      await monitor.turnEnd(started.session, sendId, prev);
      if (ending) return;
      prev = monitor.seen.get(started.session)?.sendId ?? sendId;
      await sleep(between(r, HOUR.thinkMs));
      if (ending || now() >= end) return;
      const next = await poster.followUp(
        u,
        started.session,
        "chat",
        `chat-${c.n}-${k}`,
        `${prefix}${pick(r, FOLLOWUPS)}`,
      );
      // a refused follow-up is a turn that never came: think again
      sendId = next === undefined ? prev : next;
    }
  }

  async function incident() {
    await sleep(between(r, HOUR.incidentStartMs));
    const [first, ...others] = incidentUsers;
    const started = await poster.start(
      who.get(first!)!,
      incidentTeam.id,
      incidentAgent,
      "incident",
      `inc-${mult}-1`,
      `[incident] ${INCIDENT[0]}`,
    );
    if (started === null) return;
    incidentSessions.push(started.session);
    for (let k = 2; ; k++) {
      await sleep(between(r, HOUR.incidentGapMs));
      if (ending || now() >= end) return;
      const user =
        others.length > 0 ? others[(k - 2) % others.length]! : first!;
      await poster.followUp(
        who.get(user)!,
        started.session,
        "incident",
        `inc-${mult}-${k}`,
        `[incident] ${INCIDENT[(k - 1) % INCIDENT.length]}`,
      );
    }
  }

  // Run now for the fires the automations cannot hold (past the cap a
  // project); it acts as a member of the team, under its caps too
  let cursor = 0;
  async function press(at: number) {
    await sleep(at - now());
    if (ending) return;
    const running = new Set(
      monitor
        .running()
        .filter((s) => s.automationId)
        .map((s) => s.automationId!),
    );
    for (let tries = 0; tries < active.length; tries++) {
      const a = active[cursor++ % active.length]!;
      const row = ids(a);
      if (running.has(row.id)) continue;
      const user = pick(r, pressers.get(a.team.id) ?? []);
      if (!user) continue;
      const t = now();
      const res = await api.call<{ session: { id: string } }>(
        who.get(user)!,
        "POST",
        `/api/automations/${row.id}/run`,
      );
      if (res.status === 201) {
        pressedAt.set(res.body.session.id, t);
        poster.posted(`run-${a.index}`, user, "run", t, res);
      } else poster.refuse("run", user, `run-${a.index}`, res);
      return;
    }
    poster.refused["run:none free"] =
      (poster.refused["run:none free"] ?? 0) + 1;
    out({
      t: "refused",
      at: now(),
      step: mult,
      kind: "run",
      cap: "none free",
      status: 0,
    });
  }

  const work: Promise<unknown>[] = [];
  for (const c of chats)
    work.push(sleep(T0 + c.at - now()).then(() => chat(c)));
  work.push(incident());
  for (let i = 0; i < shortBurst; i++)
    work.push(press(T0 + r() * burstMin * MIN));
  for (let i = 0; i < shortLater; i++)
    work.push(press(T0 + (burstMin + r() * (minutes - burstMin)) * MIN));
  const probed = probe(api, admin, o.personal, incidentAgent, () => ending);
  const settled = Promise.allSettled(work);

  await sleep(end - now());
  ending = true;
  out({ t: "step", n: mult, at: now(), phase: "end" });
  monitor.end();
  clearInterval(pollTimer);
  await probed;

  // the tail: a few minutes for the turns running, then stop them
  const tailStart = now();
  while (monitor.running().length > 0 && now() - tailStart < HOUR.tailMs)
    await sleep(2000);
  const left = monitor.running();
  info("tail", {
    step: mult,
    waitedMs: now() - tailStart,
    stillRunning: left.length,
  });
  await pool(left, 4, async (s) => {
    const res = await api.call(admin, "POST", `/api/sessions/${s.id}/stop`);
    out({
      t: "stopped",
      at: now(),
      step: mult,
      session: s.id,
      origin: s.origin,
      project: d.teamById.get(s.projectId)?.name ?? s.projectId,
      status: res.status,
    });
  });
  const stopWait = now();
  while (monitor.running().length > 0 && now() - stopWait < 30_000)
    await sleep(1000);
  await settled;
  clearInterval(lagTimer);
  for (const w of watchers) w.close();
  const record: StepRecord = {
    mult,
    minutes,
    T0,
    prepAt,
    chatCount,
    due,
    pressedAt,
    incidentSessions,
    refused: poster.refused,
    stopped: left.length,
    lag,
    watchers: watchers.length,
    admins: watcherAdmins.length,
    monitorCloses: monitor.closes,
  };
  await readBack(api, admin, d, monitor, record);
}
