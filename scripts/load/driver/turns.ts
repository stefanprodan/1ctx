// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// N members each keep a turn running for the whole run, back to back:
// half follow-ups in their own chats (opened first, as the page does),
// half new chats in one of their teams. Every turn's author watches it,
// so its first delta and the relay of its «ms» markers are timed, while
// the other watchers hold their feeds and the probe runs beside.

import type { SessionsResponse } from "../../../src/shared/api/sessions.ts";
import { pick, rng, shuffle } from "../random.ts";
import { HOUR } from "../shapes.ts";
import type { Api, Who } from "./api.ts";
import { Poster } from "./chats.ts";
import { type Directory, signInAll } from "./directory.ts";
import { info, now, out, pool, sleep, stats } from "./log.ts";
import { Monitor } from "./monitor.ts";
import { probe } from "./probe.ts";
import { watcherEvent } from "./readback.ts";
import { QUESTIONS } from "./texts.ts";
import { Watcher, watch } from "./watchers.ts";

export type TurnsOptions = {
  n: number;
  seconds: number;
  seed: number;
  // the text shape's share of turns asking one tool call
  toolShare: number;
  personal: string;
};

const TURN_TIMEOUT_MS = 180_000;

export async function turns(
  api: Api,
  admin: Who,
  d: Directory,
  o: TurnsOptions,
) {
  const r = rng(o.seed);
  const authors = d.members.slice(0, o.n);
  if (authors.length < o.n)
    info("fewer members than N", { members: authors.length });
  const admins = d.admins.slice(0, HOUR.watcherAdmins);
  const others = shuffle(r, d.members.slice(o.n)).slice(
    0,
    Math.max(0, HOUR.watchers - admins.length - authors.length),
  );
  const who = await signInAll(api, d, [...authors, ...admins, ...others]);
  const monitor = new Monitor(api, admin);
  await monitor.open();
  const home = new Map<string, Watcher>();
  const watchers = [
    ...authors.map((u) => {
      const w = new Watcher(api, who.get(u)!, null, 0, r);
      home.set(u, w);
      return w;
    }),
    ...admins.map((u) => new Watcher(api, who.get(u)!, null, 0, r)),
    ...others.map(
      (u, i) =>
        new Watcher(
          api,
          who.get(u)!,
          i % 2 === 0 ? null : pick(r, d.memberTeams.get(u)!),
          0,
          r,
        ),
    ),
  ];
  await pool(watchers, 8, (w) => w.connect());
  info("watchers open", {
    sockets: watchers.length,
    feedInitial: stats(watch.feedInitial),
  });

  // each author's own chats, newest first, for follow-ups
  const live = new Map<string, string[]>();
  await pool(authors, 4, async (u) => {
    const mine: string[] = [];
    for (const team of d.memberTeams.get(u)!) {
      const res = await api.call<SessionsResponse>(
        who.get(u)!,
        "GET",
        `/api/sessions?project=${team}`,
      );
      for (const row of res.body?.rows ?? []) {
        const s = row.session;
        if (
          s.ownerId === who.get(u)!.id &&
          s.origin === "chat" &&
          s.status !== "running" &&
          s.archived === null
        )
          mine.push(s.id);
      }
    }
    live.set(u, mine.slice(0, 20));
  });

  const poster = new Poster(api, o.n);
  const counts: Record<string, number> = {};
  const turnMs: number[] = [];
  const chatOpen: number[] = [];
  let n = 0;
  const lag: number[] = [];
  let tick = performance.now();
  const lagTimer = setInterval(() => {
    const t = performance.now();
    lag.push(Math.max(0, t - tick - 100));
    tick = t;
  }, 100);
  const start = now();
  const end = start + o.seconds * 1000;
  out({ t: "step", n: o.n, at: start, phase: "start", mode: "turns" });
  const probed = probe(
    api,
    admin,
    o.personal,
    d.agents[0]!.id,
    () => now() >= end,
  );

  async function turn(u: string) {
    const me = who.get(u)!;
    const mine = live.get(u)!;
    const marker = `lt-${++n}`;
    const text = `${r() < o.toolShare ? "[tool] " : ""}${pick(r, QUESTIONS)}`;
    const t0 = performance.now();
    let session: string;
    let send: string | null;
    let prev: string | null = null;
    if (r() < 0.5 && mine.length > 0) {
      session = mine[Math.floor(r() * mine.length)]!;
      const opened = await api.call(me, "GET", `/api/sessions/${session}`);
      chatOpen.push(opened.ms);
      prev = monitor.seen.get(session)?.sendId ?? null;
      home.get(u)!.follow(session, performance.now());
      const next = await poster.followUp(me, session, "chat", marker, text);
      if (next === undefined) {
        home.get(u)!.leave(session);
        await sleep(1000);
        return;
      }
      send = next;
    } else {
      const project = pick(r, d.memberTeams.get(u)!);
      const postedAt = performance.now();
      const started = await poster.start(
        me,
        project,
        pick(r, d.agents).id,
        "chat",
        marker,
        text,
      );
      if (started === null) {
        await sleep(1000);
        return;
      }
      session = started.session;
      send = started.send;
      home.get(u)!.follow(session, postedAt);
      mine.unshift(session);
    }
    const status = await Promise.race([
      monitor.turnEnd(session, send, prev),
      sleep(TURN_TIMEOUT_MS).then(() => "timeout"),
    ]);
    home.get(u)!.leave(session);
    counts[status] = (counts[status] ?? 0) + 1;
    turnMs.push(performance.now() - t0);
    out({
      t: "turn",
      at: now(),
      marker,
      user: u,
      status,
      ms: Math.round(performance.now() - t0),
    });
  }

  await Promise.all(
    authors.map(async (u, k) => {
      // the first starts spread over 5 s, so the steady state is reached
      await sleep((k / authors.length) * 5000);
      while (now() < end) await turn(u);
    }),
  );
  const elapsed = now() - start;
  out({ t: "step", n: o.n, at: now(), phase: "end", mode: "turns" });
  monitor.end();
  await probed;
  clearInterval(lagTimer);
  const left = monitor.running();
  await pool(left, 4, (s) =>
    api.call(admin, "POST", `/api/sessions/${s.id}/stop`),
  );
  for (const w of watchers) w.close();
  watcherEvent(o.n, watchers.length, admins.length, lag, monitor.closes);
  const ended =
    Object.values(counts).reduce((a, b) => a + b, 0) - (counts.timeout ?? 0);
  out({
    t: "summary",
    mode: "turns",
    step: o.n,
    n: o.n,
    seconds: o.seconds,
    elapsedS: +(elapsed / 1000).toFixed(1),
    turns: counts,
    turnsPerMin: +(ended / (elapsed / 60_000)).toFixed(1),
    refused: poster.refused,
    turnMs: { chat: stats(turnMs) },
    chatOpen: stats(chatOpen),
    stopped: left.length,
  });
}
