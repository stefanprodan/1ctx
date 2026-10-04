// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How the server feels to a user while the load runs: every second the
// routes a page loads are timed, and every 5 s a chat of the admin's is
// renamed and timed until its session frame arrives on the socket. A
// `probe` event per 15 s window, and one for the whole run.

import type {
  SessionResponse,
  SessionsResponse,
} from "../../../src/shared/api/sessions.ts";
import type { Api, Who } from "./api.ts";
import { now, out, sleep, stats } from "./log.ts";

type Sample = Record<string, number[]>;

export async function probe(
  api: Api,
  admin: Who,
  projectId: string,
  agentId: string,
  until: () => boolean,
) {
  // a live chat of the admin's own to rename, made once if none is held
  const list = await api.call<SessionsResponse>(
    admin,
    "GET",
    `/api/sessions?project=${projectId}`,
  );
  let chat = list.body?.rows?.find(
    (r) =>
      r.session.ownerId === admin.id &&
      r.session.origin === "chat" &&
      r.session.archived === null,
  )?.session.id;
  if (!chat) {
    const r = await api.call<SessionResponse>(admin, "POST", "/api/sessions", {
      projectId,
      agentId,
      message: "#probe-1 probe chat",
    });
    chat = r.body?.session?.id;
  }
  if (!chat) {
    out({ t: "error", at: now(), what: "probe has no chat" });
    return;
  }
  const waiting = new Map<string, (at: number) => void>();
  const ws = await api.socket(
    admin,
    (frame) => {
      if (frame.type !== "session") return;
      const at = performance.now();
      waiting.get(frame.session.title)?.(at);
    },
    () => {},
  );
  let window: Sample = {};
  const all: Sample = {};
  const add = (name: string, ms: number) => {
    window[name] ??= [];
    window[name].push(ms);
    all[name] ??= [];
    all[name].push(ms);
  };
  const summary = (sample: Sample) =>
    Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, stats(v)]));
  const timed = async (name: string, path: string) => {
    const r = await api.call(admin, "GET", path);
    add(r.status === 200 ? name : `${name}_${r.status}`, r.ms);
  };
  let n = 0;
  const rename = async () => {
    const title = `probe ${++n}`;
    const t = performance.now();
    const frame = new Promise<number>((ok) => waiting.set(title, ok));
    const r = await api.call(admin, "PATCH", `/api/sessions/${chat}`, {
      title,
    });
    const answered = performance.now();
    if (r.status !== 200) return add(`rename_${r.status}`, r.ms);
    add("rename_http", r.ms);
    const at = await Promise.race([frame, sleep(30_000).then(() => -1)]);
    waiting.delete(title);
    if (at < 0) add("frame_lost", 30_000);
    else {
      add("rename_frame", at - t);
      add("frame_after_answer", Math.max(0, at - answered));
    }
  };
  const started = now();
  let tick = 0;
  while (!until()) {
    const t = now();
    await Promise.all([
      timed("health", "/api/health"),
      timed("feed", "/api/sessions"),
      timed("chat", `/api/sessions/${chat}`),
      timed("projects", "/api/projects"),
      tick % 5 === 0 ? rename() : Promise.resolve(),
    ]);
    tick++;
    if (tick % 15 === 0) {
      out({
        t: "probe",
        at: now(),
        s: Math.round((now() - started) / 1000),
        routes: summary(window),
      });
      window = {};
    }
    await sleep(1000 - (now() - t));
  }
  out({ t: "probe", at: now(), phase: "total", routes: summary(all) });
  ws.close();
}
