// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One send as the app writes it: the user message, a reply per round
// with its tool results, the answer, a run's memory phase, the usage of
// every round. A send in flight stops where it is now, its rows open.

import { int, pick, type Rand as R } from "../random.ts";
import type { Build, User } from "./context.ts";
import { PACK_FROM } from "./presets.ts";
import {
  type Ctx,
  memoryPhase,
  type Profile,
  type Round,
  type Shape,
  usage,
} from "./shape.ts";
import { hex, prose } from "./text.ts";
import {
  ANSWER,
  ANSWER_HTML,
  packedOf,
  RCA,
  RCA_HTML,
  REASONING_ANSWER,
  REASONING_WORK,
  RUN_ANSWER,
  RUN_ANSWER_HTML,
  RUN_MEMORY,
  SIGNATURE,
  VARIANTS,
  WORK,
} from "./tools.ts";

const STREAM = (r: R) => prose(r, int(r, 20, 400));
const ERROR = "provider error 502: bad gateway";

type Row = {
  id: string;
  kind: "user" | "reply" | "tool";
  round: number;
  slot?: string | null;
  user?: string | null;
  agent?: string | null;
  content: string;
  reasoning?: string;
  html?: string;
  status: string;
  error?: string | null;
  finish?: string | null;
  calls?: string | null;
  callId?: string | null;
  tool?: string | null;
  model?: string | null;
  ttft?: number | null;
  thinking?: number | null;
  at: number;
  done?: number | null;
  packed?: Uint8Array | null;
  packedBytes?: number | null;
};

// the messages columns in the insert's order
function values(ctx: Ctx, send: string, seq: number, m: Row): unknown[] {
  return [
    m.id,
    ctx.id,
    seq,
    m.kind,
    send,
    m.round,
    m.slot ?? null,
    m.user ?? null,
    m.agent ?? null,
    m.content,
    m.reasoning ?? "",
    m.html ?? "",
    m.status,
    m.error ?? null,
    m.finish ?? null,
    m.calls ?? null,
    m.callId ?? null,
    m.tool ?? null,
    m.model ?? null,
    m.ttft ?? null,
    m.thinking ?? null,
    m.at,
    m.done ?? null,
    m.packed ?? null,
    m.packedBytes ?? null,
  ];
}

export function writeTurn(
  b: Build,
  ctx: Ctx,
  profile: Profile,
  kind: "chat" | "run",
  s: Shape,
  r: R,
  user: User,
  start: number,
  text: string,
  inflight: number | null,
) {
  const send = b.newId();
  const first = b.newId();
  const agent = ctx.agent;
  let t = start;
  const rows: unknown[][] = [];
  const push = (seq: number, m: Row) => rows.push(values(ctx, send, seq, m));
  const usageRows: [number, number, number, number][] = [];
  push(++ctx.seq, {
    id: first,
    kind: "user",
    round: 1,
    user: user.id,
    content: text,
    status: "done",
    at: t,
    done: t,
  });
  let round = 0;
  let calls = 0;
  let open = false;
  const ttft = () => int(r, 200, 1500);
  const reply = (
    at: number,
    extra: Partial<Row> & { content: string; status: string },
  ) => ({
    id: b.newId(),
    kind: "reply" as const,
    round,
    agent: agent.id,
    model: agent.model,
    ttft: ttft(),
    at,
    ...extra,
  });
  const writeRound = (rd: Round, memoryRound: boolean) => {
    round++;
    const replySeq = ++ctx.seq;
    const at = t;
    t += rd.ms;
    const ids = rd.calls.map(() => `call_${int(r, 100000, 999999)}`);
    const callsJson = `[${rd.calls.map((c, i) => `{"id":"${ids[i]}","name":"${c.tool.name}","arguments":${JSON.stringify(c.tool.args)},"signature":"${pick(r, SIGNATURE)}"}`).join(",")}]`;
    const work = (content: string) =>
      reply(at, {
        slot: "work",
        content,
        reasoning: pick(r, REASONING_WORK),
        html: `<p>${content}</p>`,
        status: "done",
        finish: "tool_calls",
        calls: callsJson,
        thinking: int(r, 100, 4000),
        done: at + 1500,
      });
    if (inflight !== null && t > inflight) {
      // this round is where the send is now: the reply streams, or its
      // calls run
      if (r() < 0.5 || rd.calls.length === 0) {
        push(
          replySeq,
          reply(at, {
            content: STREAM(r),
            reasoning: pick(r, REASONING_WORK).slice(0, 300),
            status: "streaming",
          }),
        );
      } else {
        push(replySeq, work(pick(r, WORK)));
        usageRows.push([round, replySeq, at, 300]);
        for (const [i, c] of rd.calls.entries()) {
          push(++ctx.seq, {
            id: b.newId(),
            kind: "tool",
            round,
            content: "",
            status: "streaming",
            callId: ids[i],
            tool: c.tool.name,
            at: at + 1500,
          });
          calls++;
        }
      }
      open = true;
      return;
    }
    push(
      replySeq,
      work(memoryRound ? "Saving what this run learned." : pick(r, WORK)),
    );
    let added = 250;
    for (const [i, c] of rd.calls.entries()) {
      const v = c.tool.variants[c.variant]!;
      const mid = b.newId();
      const pack = ctx.pack && v.bytes >= PACK_FROM;
      push(++ctx.seq, {
        id: mid,
        kind: "tool",
        round,
        content: pack ? "" : v.content,
        status: "done",
        callId: ids[i],
        tool: c.tool.name,
        at: at + 1500,
        done: at + rd.ms,
        packed: pack ? packedOf(v) : null,
        packedBytes: pack ? v.bytes : null,
      });
      if (v.kept !== null) {
        ctx.folders++;
        const dir = `${String(ctx.folders).padStart(4, "0")}-${c.tool.name.split("__").at(-1)}`;
        b.q.kept.run(mid, ctx.id, ctx.folders, dir, v.kept.length, v.kept);
        b.bump("mcp_kept_files");
      }
      added += Math.ceil(v.bytes / 4);
      calls++;
    }
    usageRows.push([round, replySeq, at, added]);
  };
  for (const rd of s.rounds) {
    writeRound(rd, false);
    if (open) break;
  }
  let status: string = s.outcome;
  if (!open) {
    // the answer round
    round++;
    const at = t;
    t += s.answerMs;
    const seq = ++ctx.seq;
    if (inflight !== null && t > inflight) {
      push(
        seq,
        reply(at, {
          content: STREAM(r),
          reasoning: pick(r, REASONING_ANSWER).slice(0, 500),
          status: "streaming",
        }),
      );
      open = true;
    } else {
      const ai = int(r, 0, 63);
      const rca = profile === "incident" && text.startsWith("Write the RCA");
      const failed = s.outcome === "failed";
      const content = failed
        ? ""
        : rca
          ? RCA[ai % 32]!
          : kind === "run"
            ? RUN_ANSWER[ai]!
            : ANSWER[ai]!;
      const html = failed
        ? ""
        : rca
          ? RCA_HTML[ai % 32]!
          : kind === "run"
            ? RUN_ANSWER_HTML[ai]!
            : ANSWER_HTML[ai]!;
      const half = (x: string) =>
        s.outcome === "stopped" ? x.slice(0, x.length >> 1) : x;
      push(
        seq,
        reply(at, {
          slot: "answer",
          content: half(content),
          reasoning: pick(r, REASONING_ANSWER),
          html: half(html),
          status: s.outcome,
          error: failed ? ERROR : null,
          finish: s.outcome === "done" ? "stop" : null,
          thinking: int(r, 100, 4000),
          done: t,
        }),
      );
      usageRows.push([round, seq, at, 200]);
    }
  }
  let memoryRound: number | null = null;
  if (!open && memoryPhase(s)) {
    // the memory phase: its own round, work-slotted, then a closing reply
    const memoryCalls = Array.from({ length: s.memory }, () => ({
      tool: RUN_MEMORY,
      variant: Math.floor(r() * VARIANTS),
    }));
    writeRound({ calls: memoryCalls, ms: 5_000 }, true);
    memoryRound = round;
    if (!open) {
      const at = t;
      t += 1_000;
      const saved = "Saved to the automation's memory.";
      push(++ctx.seq, {
        ...reply(at, {
          slot: "work",
          content: saved,
          html: `<p>${saved}</p>`,
          status: "done",
          finish: "stop",
          done: t,
        }),
        ttft: int(r, 200, 900),
      });
    }
  }
  if (open) status = "running";
  const cause =
    status === "running"
      ? null
      : status === "done"
        ? "finish"
        : status === "failed"
          ? "failure"
          : kind === "run" && status === "stopped"
            ? "deadline"
            : "stop";
  const p = agent.provider;
  b.q.send.run(
    send,
    ctx.id,
    kind,
    user.id,
    agent.id,
    p.id,
    p.name,
    agent.model,
    status,
    cause,
    status === "failed" ? ERROR : null,
    first,
    Math.max(1, round),
    calls,
    start,
    status === "running" ? null : t,
    hex(r, 64),
    memoryRound,
  );
  b.bump("sends");
  for (const row of rows) b.q.message.run(...(row as never[]));
  b.bump("messages", rows.length);
  for (const [rd, seq, at, added] of usageRows) {
    usage(b, ctx, send, user.id, rd, seq, at, r, added);
  }
  return { send, end: t, status, rounds: Math.max(1, round), cause };
}
