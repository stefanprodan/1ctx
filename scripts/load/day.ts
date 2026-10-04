// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The day shape: one turn's rounds of tool calls per kind (a chat turn,
// an hourly check, a daily report, the incident), chosen only from the
// tools the request offers, arguments from their schemas. Deterministic
// per (marker, kind, offered tools), so runs repeat.

import { TOPICS } from "./knowledge.ts";
import { latencyMs } from "./latency.ts";
import {
  cumulative,
  hash32,
  int,
  pick,
  type Rand,
  rng,
  weighted,
} from "./random.ts";
import { CHAT_CALLS, type Kind, MIX, REPLY, ROUNDS } from "./shapes.ts";

export type Call = {
  name: string;
  arguments: string;
  // the MCP tool's wire name, and the time the fake MCP takes for it
  mcpTool: string | null;
  mcpMs: number;
};
export type Round = { calls: Call[] };
export type Plan = { rounds: Round[]; reply: number };

export type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
};

export type Offered = {
  names: Set<string>;
  schemas: Map<string, Schema>;
  // wire names of the MCP tools, direct (all mode) or behind mcp_call
  mcp: string[];
  direct: boolean;
  memory: boolean;
  // a run's memory phase offers memory_edit with "none" and no bash
  memoryPhase: boolean;
  bash: boolean;
  describe: boolean;
};

const APPS = [
  "podinfo",
  "checkout",
  "ledger",
  "gateway",
  "indexer",
  "notifier",
  "billing",
  "catalog",
];
const NS = [
  "apps",
  "monitoring",
  "ingress",
  "payments",
  "search",
  "auth",
  "data",
];
// fixed text per topic: a later set of the same text finds the note
// already holding it, so concurrent chats never conflict
const MEMORY: [string, string][] = [
  [
    "deploy windows",
    "Production deploys run Tuesday to Thursday, 10:00 to 16:00, never on Fridays.",
  ],
  [
    "cluster names",
    "The production clusters are prod-eu-1 and prod-us-1; the test cluster is test-eu-1.",
  ],
  [
    "on-call",
    "The platform on-call rotates weekly on Monday at 09:00, handover in the ops channel.",
  ],
  [
    "helm conventions",
    "Charts pin image digests and set memory limits; values live under charts/<app>/values.yaml.",
  ],
  [
    "release process",
    "A release is tagged from main after the e2e suite passes.",
  ],
  [
    "incident docs",
    "Incident write-ups go to /knowledge/incidents/<id>.md with a timeline and an RCA.",
  ],
];

export function offeredOf(body: Record<string, unknown>): Offered {
  const tools =
    (body.tools as { function?: { name?: string; parameters?: Schema } }[]) ??
    [];
  const names = new Set<string>();
  const schemas = new Map<string, Schema>();
  for (const t of tools) {
    const name = t.function?.name;
    if (typeof name !== "string") continue;
    names.add(name);
    schemas.set(name, t.function?.parameters ?? {});
  }
  let mcp = [...names].filter((n) => n.startsWith("mcp__"));
  const direct = mcp.length > 0;
  if (!direct && names.has("mcp_call")) {
    const e = schemas.get("mcp_call")?.properties?.name?.enum;
    mcp = Array.isArray(e)
      ? e.filter((n): n is string => typeof n === "string")
      : [];
  }
  const memEnum = schemas.get("memory_edit")?.properties?.action?.enum ?? [];
  const memoryPhase =
    names.has("memory_edit") && memEnum.includes("none") && !names.has("bash");
  return {
    names,
    schemas,
    mcp,
    direct,
    memory: names.has("memory_edit") && memEnum.includes("set") && !memoryPhase,
    memoryPhase,
    bash: names.has("bash"),
    describe: names.has("mcp_describe"),
  };
}

export function bareOf(wire: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(wire);
  return m ? { server: m[1]!, tool: m[2]! } : { server: "", tool: wire };
}

// a value per schema type, so the arguments validate
function valueFor(r: Rand, name: string, s: Schema, query: string): unknown {
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  switch (s.type) {
    case "string":
      if (name === "namespace") return pick(r, NS);
      if (name === "kind") {
        return pick(r, ["HelmRelease", "Kustomization", "Deployment"]);
      }
      if (name === "repo") return `platform/${pick(r, APPS)}`;
      if (name === "ref") return "main";
      return query;
    case "integer":
    case "number":
      return 1 + Math.floor(r() * 20);
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return query;
  }
}

function mcpArgs(
  r: Rand,
  schema: Schema | undefined,
  query: string,
  large: boolean,
): Record<string, unknown> {
  const props = schema?.properties ?? {
    query: { type: "string" },
    size: { type: "string" },
  };
  const required = schema?.required ?? ["query"];
  const args: Record<string, unknown> = {};
  for (const name of required) {
    args[name] = valueFor(r, name, props[name] ?? {}, query);
  }
  if ("query" in props && !("query" in args)) args.query = query;
  for (const name of Object.keys(props)) {
    if (name in args || name === "size" || name === "query") continue;
    if (r() < 0.3) args[name] = valueFor(r, name, props[name]!, query);
  }
  if ("size" in props && large) args.size = "large";
  return args;
}

function mcpCall(
  r: Rand,
  o: Offered,
  wire: string,
  query: string,
  large: boolean,
): Call {
  const { tool } = bareOf(wire);
  if (o.direct) {
    const args = mcpArgs(r, o.schemas.get(wire), query, large);
    return {
      name: wire,
      arguments: JSON.stringify(args),
      mcpTool: wire,
      mcpMs: latencyMs(tool, args),
    };
  }
  // catalog mode: the fakes' schema, query and size
  const args: Record<string, unknown> = { query };
  if (large) args.size = "large";
  return {
    name: "mcp_call",
    arguments: JSON.stringify({ name: wire, arguments: args }),
    mcpTool: wire,
    mcpMs: latencyMs(tool, args),
  };
}

const bash = (command: string): Call => ({
  name: "bash",
  arguments: JSON.stringify({ command }),
  mcpTool: null,
  mcpMs: 0,
});

function jsonDoc(r: Rand, bytes: number): string {
  const items: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const status =
      r() < 0.8
        ? "Ready"
        : pick(r, ["CrashLoopBackOff", "OOMKilled", "Pending"]);
    const item = JSON.stringify({
      name: `${pick(r, APPS)}-${i}`,
      namespace: pick(r, NS),
      status,
      restarts: Math.floor(r() * 9),
      node: `node-${Math.floor(r() * 40)}`,
      cpu: Math.floor(r() * 900),
      memMi: Math.floor(64 + r() * 960),
    });
    items.push(`  ${item}`);
    size += item.length + 4;
  }
  return `{"items": [\n${items.join(",\n")}\n]}`;
}

function report(r: Rand, title: string, lines: number): string {
  const out = [`# ${title}`, ""];
  for (let i = 0; i < lines; i++) {
    out.push(
      `- ${pick(r, NS)}/${pick(r, APPS)}: ${pick(r, TOPICS)} after the rollout, restarts ${Math.floor(r() * 9)}, owner team-${Math.floor(r() * 10)}`,
    );
  }
  return out.join("\n");
}

// commands of the kind real chats run: tens to hundreds of ms each
function chatBash(r: Rand, slot: number): string {
  const topic = pick(r, TOPICS);
  const kind = pick(r, ["pods", "releases", "nodes", "alerts"]);
  const file = `/tmp/${kind}-${slot}.json`;
  const doc = (lo: number, span: number) =>
    `cat > ${file} <<'EOF'\n${jsonDoc(r, lo + Math.floor(r() * span))}\nEOF\n`;
  switch (Math.floor(r() * 6)) {
    case 0:
      return `${doc(1500, 4000)}jq -r '.items[] | select(.status != "Ready") | "\\(.namespace)/\\(.name) \\(.restarts)"' ${file} | sort | head -20; jq '.items | length' ${file}`;
    case 1:
      return `${doc(1500, 4000)}jq -r '.items[] | [.namespace, .restarts, .memMi] | @tsv' ${file} | awk '{r[$1]+=$2; m[$1]+=$3} END {for (k in r) print k, r[k], m[k]}' | sort -k2 -nr | head`;
    case 2:
      return `rg -il '${topic}' /knowledge | head -20; rg -il '${topic}' /knowledge | wc -l`;
    case 3:
      return `f=$(rg -il '${topic}' /knowledge | head -1); if [ -n "$f" ]; then wc -l "$f"; grep -n '^#' "$f" | head -20; sed -n '1,40p' "$f"; else echo "no doc mentions ${topic}"; fi`;
    case 4:
      return `${doc(1000, 3000)}jq -r '.items[].node' ${file} | sort | uniq -c | sort -nr | head; wc -l ${file}`;
    default:
      return `ls -la /tmp | head -20; rg -n -i '${topic}' /knowledge/runbooks 2>/dev/null | head -15 | cut -c1-160`;
  }
}

// commands over the MCP results kept under /mcp
function incidentBash(r: Rand): string {
  const topic = pick(r, ["oomkilled", "crashloop", "timeout", "503", "error"]);
  switch (Math.floor(r() * 5)) {
    case 0:
      return `ls -R /mcp 2>/dev/null | head -40; rg -c -i '${topic}' /mcp 2>/dev/null | sort -t: -k2 -nr | head -10`;
    case 1:
      return `rg -n -i '${topic}' /mcp 2>/dev/null | head -30 | cut -c1-200`;
    case 2:
      return `for f in $(find /mcp -name '*.json' 2>/dev/null | head -5); do echo "$f"; jq -r 'if type == "object" and has("items") then (.items | length) else type end' "$f"; done; echo done`;
    case 3:
      return `rg -il '${topic}' /knowledge/incidents 2>/dev/null | head -10; f=$(rg -il '${topic}' /knowledge | head -1); [ -n "$f" ] && sed -n '1,30p' "$f" || echo "no doc"`;
    default:
      return `find /mcp -type f 2>/dev/null | head -20 | while read f; do printf '%s %s\\n' "$(wc -l < "$f")" "$f"; done | sort -nr | head`;
  }
}

const READS = /^(get|search|list|read|trace)_/;

function pickMcp(r: Rand, o: Offered): string {
  const reads = o.mcp.filter((w) => READS.test(bareOf(w).tool));
  return pick(r, reads.length > 0 && r() < ROUNDS.readShare ? reads : o.mcp);
}

function save(path: string, body: string): Call {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return bash(
    `mkdir -p ${dir} && cat > ${path} <<'EOF'\n${body}\nEOF\nwc -l ${path}`,
  );
}

const range = (r: Rand, [a, b]: readonly number[]) => int(r, a!, b!);

export function dayPlan(
  marker: string,
  kind: Kind,
  o: Offered,
  key: string,
): Plan {
  const r = rng(hash32(`${key}\n${kind}\n${[...o.names].sort().join(",")}`));
  const slot = hash32(key) % 3;
  if (o.memoryPhase) {
    const none = JSON.stringify({ action: "none" });
    const call = {
      name: "memory_edit",
      arguments: none,
      mcpTool: null,
      mcpMs: 0,
    };
    return { rounds: [{ calls: [call] }], reply: REPLY.memoryPhase };
  }
  const shape = kind === "incident" ? MIX.incident : MIX.chat;
  const mix: [string, number][] = [];
  if (o.mcp.length > 0) mix.push(["mcp", shape.mcp]);
  if (o.bash) mix.push(["bash", shape.bash]);
  if (o.memory) mix.push(["memory", shape.memory]);
  if (o.describe) mix.push(["describe", shape.describe]);
  if (mix.length === 0) {
    const run = kind !== "chat" && kind !== "incident";
    return {
      rounds: [],
      reply: range(r, run ? REPLY.noTools.run : REPLY.noTools.chat),
    };
  }
  let mcpCount = 0;
  const large = () =>
    mcpCount % ROUNDS.largeEvery === ROUNDS.largeAt &&
    (kind === "incident" || kind === "daily");
  const make = (what: string): Call => {
    const query = `${pick(r, APPS)} ${pick(r, TOPICS)} ${marker}`.trim();
    switch (what) {
      case "mcp":
        mcpCount++;
        return mcpCall(r, o, pickMcp(r, o), query, large());
      case "bash":
        if (kind === "incident" && r() < ROUNDS.incidentMcpBash) {
          return bash(incidentBash(r));
        }
        if (kind === "daily" && r() < ROUNDS.dailyMcpGrep) {
          return bash(incidentBash(r));
        }
        return bash(chatBash(r, slot));
      case "memory": {
        const [topic, text] = pick(r, MEMORY);
        return {
          name: "memory_edit",
          arguments: JSON.stringify({ action: "set", topic, text }),
          mcpTool: null,
          mcpMs: 0,
        };
      }
      default:
        return {
          name: "mcp_describe",
          arguments: JSON.stringify({ name: pickMcp(r, o) }),
          mcpTool: null,
          mcpMs: 0,
        };
    }
  };
  const rounds: Round[] = [];
  const many = (n: number, k: () => number, m: [string, number][]) => {
    for (let i = 0; i < n; i++) {
      rounds.push({
        calls: Array.from({ length: k() }, () => make(weighted(r, m))),
      });
    }
  };
  // an hourly check: rounds of two calls, mostly MCP; a daily report:
  // more rounds of more calls, large results kept and grepped, then the
  // report written to /knowledge/reports
  if (kind === "hourly" || kind === "daily") {
    const s = kind === "daily" ? ROUNDS.daily : ROUNDS.hourly;
    const runMix = mix.map(([w, p]): [string, number] => [
      w,
      w === "mcp" ? p + MIX.runMcpExtra : p,
    ]);
    many(range(r, s.rounds), () => range(r, s.calls), runMix);
    if (kind === "daily" && o.bash) {
      const path = `/knowledge/reports/${marker || "run"}.md`;
      const body = report(r, `Daily report ${marker}`, int(r, 20, 44));
      rounds.push({ calls: [save(path, body)] });
    }
    return { rounds, reply: range(r, REPLY.scheduled) };
  }
  if (kind === "incident") {
    const s = ROUNDS.incident;
    many(range(r, s.rounds), () => range(r, s.calls), mix);
    if (o.bash) {
      const path = `/knowledge/incidents/${marker || `inc-${key.length}`}.md`;
      const events = report(r, "Events", 10).split("\n").slice(2).join("\n");
      const body = `${report(r, `RCA ${marker}`, int(r, 25, 54))}\n\n## Timeline\n\n${events}`;
      rounds.push({ calls: [save(path, body)] });
    }
    return { rounds, reply: range(r, REPLY.incident) };
  }
  const total = cumulative(r, CHAT_CALLS);
  const calls = Array.from({ length: total }, () => make(weighted(r, mix)));
  if (kind === "chat" && o.bash && total > 0 && r() < ROUNDS.saveReport) {
    const path = `/knowledge/reports/${marker || "report"}.md`;
    calls.push(save(path, report(r, `Report ${marker}`, int(r, 15, 34))));
  }
  const pair = kind === "run" ? ROUNDS.pairRun : ROUNDS.pairChat;
  for (let i = 0; i < calls.length; i++) {
    if (i + 1 < calls.length && r() < pair) {
      rounds.push({ calls: [calls[i]!, calls[i + 1]!] });
      i++;
    } else rounds.push({ calls: [calls[i]!] });
  }
  return { rounds, reply: range(r, kind === "run" ? REPLY.run : REPLY.chat) };
}
