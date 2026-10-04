// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One results row per run, from either target's logs in
// out/results/<label>/: the driver's events (turns, sends, refusals,
// watchers, probe), the fake model's requests (the server's own time
// between rounds, less the MCP time a round cost), the server's log
// (errors, failed tools), and CPU and memory every 5 s.
//
//   bun scripts/load/summarize.ts [--json] LABEL|DIR...

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

type Event = Record<string, any>;
type Q = { n: number; p50: number; p95: number; p99: number; max: number };

const OUT = resolve(import.meta.dir, "out", "results");

export function q(xs: readonly number[]): Q {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) =>
    s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s.at(-1) ?? 0,
  };
}

async function lines(dir: string, name: string): Promise<string[]> {
  const f = Bun.file(join(dir, `${name}.log`));
  return (await f.exists()) ? (await f.text()).split("\n").filter(Boolean) : [];
}

function json(ls: string[]): Event[] {
  return ls.flatMap((l) => {
    if (!l.startsWith("{")) return [];
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

export type Row = {
  label: string;
  target: string;
  mode: string;
  step: number | null;
  turns: Record<string, number>;
  turnsPerMin: number | null;
  turnMs: Q;
  runMs: Q;
  // the server's own time between a round's end and the next request
  gapMs: Q;
  // a post to the fake model's first request of its turn
  firstRequestMs: Q;
  latenessMs: Q;
  relayMs: Q;
  firstDeltaMs: Q;
  feedRefreshMs: Q;
  // a rename whose frame never came, or that failed, counts as an error
  probe: { feed: Q; renameFrame: Q; framesLost: number; renamesFailed: number };
  cpuM: Q;
  memMi: Q;
  refused: number;
  serverErrors: number;
  toolFailed: Record<string, number>;
  commandErrors: number;
  mcpCalls: number;
  reasks: number;
};

const empty = q([]);
const pq = (s: Event | undefined): Q =>
  s && s.n > 0
    ? { n: s.n, p50: s.p50, p95: s.p95, p99: s.p99 ?? s.p95, max: s.max }
    : empty;

export async function summarize(dirOrLabel: string): Promise<Row> {
  const dir = existsSync(dirOrLabel)
    ? resolve(dirOrLabel)
    : join(OUT, dirOrLabel);
  const meta: Event = (await Bun.file(join(dir, "meta.json")).exists())
    ? await Bun.file(join(dir, "meta.json")).json()
    : {};
  const driver = json(await lines(dir, "driver"));
  const model = json(await lines(dir, "model"));
  const mcp = json(await lines(dir, "mcp"));
  const summary = driver.find((e) => e.t === "summary") ?? {};
  const watchers = driver.find((e) => e.t === "watchers") ?? {};

  // the gap: request for round n+1 against the end of round n, less the
  // slowest MCP call of round n, which ran in parallel
  const ends = new Map<string, { at: number; mcp: number }[]>();
  for (const e of model.filter(
    (e) => e.t === "end" && !e.final && !e.aborted,
  )) {
    const k = `${e.marker}/${e.round}`;
    const mcpMs = Math.max(
      0,
      ...e.calls.map((c: { mcpMs: number }) => c.mcpMs),
    );
    const list = ends.get(k) ?? [];
    list.push({ at: e.at, mcp: mcpMs });
    ends.set(k, list);
  }
  const posted = new Map<string, number>();
  for (const d of driver.filter((d) => d.t === "post"))
    posted.set(d.marker, d.at);
  const gaps: number[] = [];
  const first: number[] = [];
  // a second request for a marker's round re-asks it after the answer
  // (a run's memory phase, a decider's attention read, a compaction's
  // summary): counted apart, never a gap between rounds
  const asked = new Set<string>();
  let reasks = 0;
  let commandErrors = 0;
  for (const r of model.filter((e) => e.t === "req")) {
    commandErrors += r.errors ?? 0;
    const k = `${r.marker}/${r.round}`;
    if (asked.has(k)) {
      reasks++;
      continue;
    }
    asked.add(k);
    if (r.round > 0) {
      const prior = (ends.get(`${r.marker}/${r.round - 1}`) ?? [])
        .filter((e) => e.at <= r.at)
        .at(-1);
      if (prior) gaps.push(r.at - prior.at - prior.mcp);
    } else if (posted.has(r.marker)) first.push(r.at - posted.get(r.marker)!);
  }

  const top = json(await lines(dir, "top")).filter((e) => e.t === "top");
  const server = await lines(dir, "server");
  let serverErrors = 0;
  const toolFailed: Record<string, number> = {};
  // a send the driver stopped at the end aborts its tool calls; those
  // failures are the stop, not the server's
  const stopped = new Set(
    driver.filter((e) => e.t === "stopped").map((e) => e.session),
  );
  for (const l of server) {
    if (l.includes("level=ERROR")) serverErrors++;
    if (!l.includes('msg="tool failed"')) continue;
    if (stopped.has(l.match(/ chat=(\S+)/)?.[1])) continue;
    const k = [/tool=(\S+)/, /phase=(\S+)/, /cause=(\S+)/]
      .map((re) => l.match(re)?.[1] ?? "")
      .filter(Boolean)
      .join(" ");
    toolFailed[k] = (toolFailed[k] ?? 0) + 1;
  }
  const probe =
    driver.filter((e) => e.t === "probe" && e.phase === "total").at(-1)
      ?.routes ?? {};
  const turns: Record<string, number> =
    summary.mode === "turns" ? (summary.turns ?? {}) : (summary.sends ?? {});
  const refused = Object.values(
    (summary.refused ?? {}) as Record<string, number>,
  ).reduce((a, b) => a + b, 0);
  return {
    label: dir.split("/").at(-1)!,
    target: meta.target ?? "-",
    mode: summary.mode ?? "-",
    step: summary.step ?? null,
    turns,
    turnsPerMin: summary.turnsPerMin ?? null,
    turnMs: pq(summary.turnMs?.chat),
    runMs: pq(summary.turnMs?.run),
    gapMs: q(gaps),
    firstRequestMs: q(first),
    latenessMs: pq(summary.lateness),
    relayMs: pq(watchers.relay),
    firstDeltaMs: pq(watchers.firstDelta),
    feedRefreshMs: pq(watchers.feedRefresh),
    probe: {
      feed: pq(probe.feed),
      renameFrame: pq(probe.rename_frame),
      framesLost: probe.frame_lost?.n ?? 0,
      renamesFailed: Object.entries(probe as Record<string, Event>)
        .filter(([k]) => /^rename_\d+$/.test(k))
        .reduce((n, [, v]) => n + (v.n ?? 0), 0),
    },
    cpuM: q(top.map((e) => e.cpuM)),
    memMi: q(top.map((e) => e.memMi)),
    refused,
    serverErrors,
    toolFailed,
    commandErrors,
    mcpCalls: mcp.filter((e) => e.t === "call").length,
    reasks,
  };
}

const ms = (x: Q, a: keyof Q = "p50", b: keyof Q = "p95") =>
  x.n === 0 ? "-" : `${Math.round(x[a])} / ${Math.round(x[b])}`;
const sec = (x: Q) =>
  x.n === 0
    ? "-"
    : `${(x.p50 / 1000).toFixed(1)} / ${(x.p95 / 1000).toFixed(1)}`;
const tally = (o: Record<string, number>) =>
  Object.entries(o)
    .sort()
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "-";

export const COLUMNS = [
  "run",
  "target",
  "step",
  "turns",
  "turns/min",
  "turn s p50/p95",
  "run s p50/p95",
  "server gap ms p50/p95",
  "first request ms p50/p95",
  "lateness ms p50/p95",
  "relay ms p50/p99",
  "first delta ms p50/p95",
  "feed refresh ms p50/p95",
  "probe feed ms p95/max",
  "probe frame ms p95/max",
  "CPU m p50/max",
  "RSS Mi max",
  "refused",
  "errors",
];

export function cells(r: Row): string[] {
  const failed = Object.values(r.toolFailed).reduce((a, b) => a + b, 0);
  return [
    r.label,
    r.target,
    r.step === null ? "-" : `${r.mode} ${r.step}`,
    tally(r.turns),
    r.turnsPerMin === null ? "-" : String(r.turnsPerMin),
    sec(r.turnMs),
    sec(r.runMs),
    ms(r.gapMs),
    ms(r.firstRequestMs),
    ms(r.latenessMs),
    ms(r.relayMs, "p50", "p99"),
    ms(r.firstDeltaMs),
    ms(r.feedRefreshMs),
    ms(r.probe.feed, "p95", "max"),
    `${ms(r.probe.renameFrame, "p95", "max")}${r.probe.framesLost > 0 ? `, ${r.probe.framesLost} lost` : ""}`,
    ms(r.cpuM, "p50", "max"),
    r.memMi.n === 0 ? "-" : String(Math.round(r.memMi.max)),
    String(r.refused),
    `${r.serverErrors} server, ${failed} tool, ${r.commandErrors} exit, ${r.probe.framesLost + r.probe.renamesFailed} probe`,
  ];
}

export function table(rows: Row[]): string {
  const out = [
    `| ${COLUMNS.join(" | ")} |`,
    `|${COLUMNS.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${cells(r).join(" | ")} |`),
  ];
  return out.join("\n");
}

export function printTable(rows: Row[]) {
  console.log(table(rows));
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const labels =
    args.length > 0 ? args : existsSync(OUT) ? readdirSync(OUT).sort() : [];
  const rows = await Promise.all(labels.map(summarize));
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
}
