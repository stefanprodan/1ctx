// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send's shape before its rows: rounds of tool calls drawn from the
// mix of its kind, how long each takes, how it ends, a run's memory
// phase; and the usage row each round leaves.

import { int, type Rand as R, rng, weighted } from "../random.ts";
import type { Agent, Build, User } from "./context.ts";
import { NOW } from "./presets.ts";
import {
  CHAT_MIX,
  INCIDENT_MIX,
  RUN_MIX,
  type Tool,
  VARIANTS,
} from "./tools.ts";

export type Ctx = {
  id: string;
  project: string;
  agent: Agent;
  seq: number;
  context: number;
  folders: number;
  pack: boolean;
};
export type Call = { tool: Tool; variant: number };
export type Round = { calls: Call[]; ms: number };
export type Shape = {
  rounds: Round[];
  answerMs: number;
  outcome: "done" | "failed" | "stopped";
  memory: number;
};
export type Profile = "chat" | "run" | "incident";

export function shape(
  seed: number,
  profile: Profile,
  ownMemory = false,
): Shape {
  const r = rng(seed);
  const mix =
    profile === "chat" ? CHAT_MIX : profile === "run" ? RUN_MIX : INCIDENT_MIX;
  const toolRounds =
    profile === "chat"
      ? r() < 0.25
        ? 0
        : int(r, 1, 12)
      : profile === "run"
        ? weighted(r, [
            [1, 4],
            [2, 4],
            [3, 2],
          ] as const)
        : int(r, 16, 32);
  const rounds: Round[] = [];
  for (let k = 0; k < toolRounds; k++) {
    const n = weighted(r, [
      [1, 70],
      [2, 22],
      [3, 8],
    ] as const);
    const calls: Call[] = [];
    for (let c = 0; c < n; c++)
      calls.push({
        tool: weighted(r, mix),
        variant: Math.floor(r() * VARIANTS),
      });
    rounds.push({
      calls,
      ms: int(r, 2_000, 9_000) + calls.length * int(r, 300, 3_000),
    });
  }
  const x = r();
  const outcome = x < 0.965 ? "done" : x < 0.985 ? "failed" : "stopped";
  const memory =
    profile === "run" && ownMemory
      ? weighted(r, [
          [1, 3],
          [2, 4],
          [3, 2],
        ] as const)
      : 0;
  return { rounds, answerMs: int(r, 3_000, 25_000), outcome, memory };
}
export const memoryPhase = (s: Shape) => s.memory > 0 && s.outcome !== "failed";
export const shapeMs = (s: Shape) =>
  s.rounds.reduce((n, x) => n + x.ms, 0) +
  s.answerMs +
  (memoryPhase(s) ? 6_000 : 0);
export const shapeRounds = (s: Shape) =>
  s.rounds.length + 1 + (memoryPhase(s) ? 1 : 0);
// where a send in flight is now: past half its course, never past now
export const cutAt = (start: number, s: Shape) =>
  Math.min(NOW, start + Math.floor(shapeMs(s) * 0.6));

export function usage(
  b: Build,
  ctx: Ctx,
  send: string,
  user: string,
  round: number,
  seq: number,
  at: number,
  r: R,
  added: number,
) {
  ctx.context = Math.min(ctx.context + added, 480_000);
  const completion = int(r, 30, 700);
  const prompt = ctx.context;
  b.q.usage.run(
    b.newId(),
    send,
    ctx.id,
    ctx.project,
    user,
    ctx.agent.id,
    ctx.agent.provider.id,
    ctx.agent.model,
    round,
    seq,
    prompt,
    completion,
    Math.floor(prompt * 0.7),
    Math.floor(completion * 0.6),
    (prompt * 0.3 + completion * 1.2) / 1e6,
    at,
  );
  b.bump("usage");
  ctx.context += completion;
}

// the rounds of a send that no longer exists: its usage alone
export function usageOnly(
  b: Build,
  ctx: Ctx,
  s: Shape,
  r: R,
  user: User,
  start: number,
) {
  const send = b.newId();
  let t = start;
  let seq = 1;
  let round = 0;
  for (const rd of s.rounds) {
    round++;
    seq++;
    usage(
      b,
      ctx,
      send,
      user.id,
      round,
      seq,
      t,
      r,
      250 +
        rd.calls.reduce(
          (n, c) => n + Math.ceil(c.tool.variants[c.variant]!.bytes / 4),
          0,
        ),
    );
    seq += rd.calls.length;
    t += rd.ms;
  }
  round++;
  seq++;
  usage(b, ctx, send, user.id, round, seq, t, r, 200);
  t += s.answerMs;
  if (memoryPhase(s)) {
    round++;
    seq++;
    usage(b, ctx, send, user.id, round, seq, t, r, 100);
    t += 6_000;
  }
  return t;
}
