// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools a built history calls, their result sizes, the mix per kind
// of send, and the pooled texts of messages, answers and notes.

import {
  MEMORY_CHARS,
  MEMORY_TOPIC_CHARS,
  memoryChars,
} from "../../../src/shared/memory.ts";
import { int, pick, type Rand as R, rng } from "../random.ts";
import { hash, lognormal } from "./ids.ts";
import { CUT_NOTE, RESULT_CUT } from "./presets.ts";
import {
  APPS,
  bash,
  hex,
  markdown,
  PROSE,
  prose,
  type Style,
  slice,
} from "./text.ts";

// A tool's results: a fixed set of variants drawn from its size
// distribution, each packed at most once. Means per tool and origin as
// measured on a working instance; sigma spreads them into the tail.
export type Variant = {
  content: string;
  bytes: number;
  packed: Uint8Array | null;
  // the whole result when the content was cut
  kept: string | null;
};
export type Tool = {
  name: string;
  style: Style;
  mean: number;
  sigma: number;
  args: string;
  variants: Variant[];
};
export const VARIANTS = 48;
function tool(
  name: string,
  style: Style,
  mean: number,
  sigma: number,
  args: string,
): Tool {
  const r = rng(
    hash(...[...name].map((c) => c.charCodeAt(0)), Math.round(mean)),
  );
  const variants: Variant[] = [];
  for (let i = 0; i < VARIANTS; i++) {
    const size = Math.max(
      40,
      Math.min(400_000, Math.round(lognormal(r, mean, sigma))),
    );
    if (size > RESULT_CUT) {
      const whole = slice(r, style, size);
      const content = whole.slice(0, RESULT_CUT - CUT_NOTE.length) + CUT_NOTE;
      const mcp = name.startsWith("mcp__");
      variants.push({
        content,
        bytes: content.length,
        packed: null,
        kept: mcp ? whole : null,
      });
    } else {
      const content = slice(r, style, size);
      variants.push({
        content,
        bytes: content.length,
        packed: null,
        kept: null,
      });
    }
  }
  return { name, style, mean, sigma, args, variants };
}
export function packedOf(v: Variant): Uint8Array {
  v.packed ??= Bun.zstdCompressSync(Buffer.from(v.content), { level: 3 });
  return v.packed;
}

const T = {
  bash: (mean: number, sigma = 1.1) =>
    tool(
      "bash",
      "bash",
      mean,
      sigma,
      `{"command":"rg -n -i 'oomkilled|backoff' /mcp /knowledge | head -80"}`,
    ),
  resources: (mean: number, sigma = 0.9) =>
    tool(
      "mcp__cluster__get_kubernetes_resources",
      "yaml",
      mean,
      sigma,
      `{"apiVersion":"apps/v1","kind":"Deployment","namespace":"payments-prod"}`,
    ),
  logs: (mean: number, sigma = 1) =>
    tool(
      "mcp__cluster__get_kubernetes_logs",
      "logs",
      mean,
      sigma,
      `{"pod_name":"payments-api-7f9c8d6b5-xk2p9","pod_namespace":"payments-prod","limit":2000}`,
    ),
  events: (mean: number, sigma = 0.8) =>
    tool(
      "mcp__cluster__get_kubernetes_events",
      "events",
      mean,
      sigma,
      `{"namespace":"payments-prod"}`,
    ),
  instance: (mean: number, sigma = 0.3) =>
    tool("mcp__cluster__get_flux_instance", "yaml", mean, sigma, `{}`),
  trace: (mean: number, sigma = 0.6) =>
    tool(
      "mcp__cluster__trace_kubernetes_resource",
      "yaml",
      mean,
      sigma,
      `{"kind":"Deployment","name":"payments-api","namespace":"payments-prod"}`,
    ),
  metrics: (mean: number, sigma = 0.6) =>
    tool(
      "mcp__cluster__get_kubernetes_metrics",
      "json",
      mean,
      sigma,
      `{"namespace":"payments-prod"}`,
    ),
  file: (mean: number, sigma = 0.9) =>
    tool(
      "mcp__git__get_file_contents",
      "yaml",
      mean,
      sigma,
      `{"repo":"platform/payments","query":"apps/payments/release.yaml"}`,
    ),
  search: (mean: number, sigma = 0.6) =>
    tool(
      "mcp__git__search_code",
      "json",
      mean,
      sigma,
      `{"query":"memory limit repo:platform/payments"}`,
    ),
  release: (mean: number, sigma = 0.35) =>
    tool(
      "mcp__git__get_latest_release",
      "json",
      mean,
      sigma,
      `{"repo":"platform/gateway","query":"latest"}`,
    ),
  models: (mean: number, sigma = 0.5) =>
    tool("mcp__docs__list_versions", "json", mean, sigma, `{}`),
  describe: (mean: number, sigma = 0.8) =>
    tool(
      "mcp_describe",
      "json",
      mean,
      sigma,
      `{"name":"mcp__cluster__get_kubernetes_resources"}`,
    ),
  webfetch: (mean: number, sigma = 0.9) =>
    tool(
      "webfetch",
      "prose",
      mean,
      sigma,
      `{"url":"https://docs.load.example/helm/releases/"}`,
    ),
  websearch: (mean: number, sigma = 0.5) =>
    tool(
      "websearch",
      "prose",
      mean,
      sigma,
      `{"query":"helm upgrade failed another operation is in progress"}`,
    ),
  skill: (mean: number, sigma = 0.3) =>
    tool("skill", "markdown", mean, sigma, `{"name":"gitops-guide"}`),
  skillFile: (mean: number, sigma = 0.5) =>
    tool(
      "skill_file",
      "markdown",
      mean,
      sigma,
      `{"name":"gitops-guide","path":"references/helmrelease.md"}`,
    ),
  memory: (mean: number, sigma = 0.4) =>
    tool(
      "memory_edit",
      "prose",
      mean,
      sigma,
      `{"action":"set","topic":"payments rollout","text":"..."}`,
    ),
  visualize: (mean: number, sigma = 0.3) =>
    tool("visualize", "prose", mean, sigma, `{"title":"error rate"}`),
  datetime: () => tool("datetime", "prose", 90, 0.1, `{}`),
};

export type Mix = readonly (readonly [Tool, number])[];
// a chat's mix over 974 calls, means in chars
export const CHAT_MIX: Mix = [
  [T.bash(1850), 45],
  [T.resources(4900), 13],
  [T.describe(1300), 6],
  [T.file(7000), 4],
  [T.events(550), 4],
  [T.webfetch(4600), 4],
  [T.websearch(12500), 2],
  [T.memory(200), 2],
  [T.logs(3100), 2],
  [T.instance(12000), 2],
  [T.skill(13000), 1.5],
  [T.models(21000), 1],
  [T.trace(930), 2],
  [T.metrics(615), 2],
  [T.visualize(140), 1.5],
  [T.search(14500), 1],
  [T.datetime(), 0.5],
];
// a run's mix over 1754 calls, the memory phase apart
export const RUN_MIX: Mix = [
  [T.instance(11800), 25],
  [T.release(31000), 25],
  [T.resources(6000), 15],
  [T.describe(250), 10],
  [T.bash(510, 0.8), 5],
  [T.events(1000), 10],
  [T.webfetch(2000), 3],
];
export const RUN_MEMORY = T.memory(100, 0.3);
// the incident: large YAMLs, events and pod logs, greps over them, skills
// loaded again after a compaction
export const INCIDENT_MIX: Mix = [
  [T.bash(2500), 30],
  [T.resources(14000, 1), 20],
  [T.logs(22000, 1), 10],
  [T.events(4000), 8],
  [T.instance(12000), 4],
  [T.trace(3000), 4],
  [T.file(7000), 7],
  [T.search(14000), 3],
  [T.describe(1300), 5],
  [T.skill(13000), 2],
  [T.skillFile(7400), 1],
  [T.memory(200), 2],
  [T.metrics(1000), 3],
];

// pooled reply texts
const pool = (n: number, f: (r: R, i: number) => string, seed: number) => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => f(r, i));
};
export const USER_CHAT = pool(64, (r) => prose(r, int(r, 60, 400)), 1);
export const USER_INCIDENT = pool(
  64,
  (r) =>
    `${pick(r, APPS)}-api is ${pick(r, ["returning 502s", "crash looping", "slow", "out of memory", "failing its health checks"])} since ${int(r, 1, 59)} minutes ago. ${prose(r, int(r, 40, 300))}`,
  2,
);
export const INSTRUCTIONS = pool(64, (r) => prose(r, int(r, 300, 1000)), 3);
export const WORK = pool(64, (r) => prose(r, int(r, 10, 60)), 4);
export const REASONING_WORK = pool(64, (r) => prose(r, int(r, 400, 1600)), 5);
export const REASONING_ANSWER = pool(64, (r) => prose(r, int(r, 300, 2000)), 6);
export const ANSWER = pool(64, (r) => markdown(r, int(r, 500, 3200)), 7);
export const ANSWER_HTML = ANSWER.map((a) =>
  a
    .split("\n\n")
    .map((p) => `<p>${p}</p>`)
    .join("\n"),
);
export const RUN_ANSWER = pool(64, (r) => markdown(r, int(r, 300, 1200)), 8);
export const RUN_ANSWER_HTML = RUN_ANSWER.map((a) =>
  a
    .split("\n\n")
    .map((p) => `<p>${p}</p>`)
    .join("\n"),
);
export const RCA = pool(32, (r) => markdown(r, int(r, 4000, 9000)), 9);
export const RCA_HTML = RCA.map((a) =>
  a
    .split("\n\n")
    .map((p) => `<p>${p}</p>`)
    .join("\n"),
);
export const SUMMARY = pool(16, (r) => markdown(r, int(r, 3000, 6000)), 10);
export const SIGNATURE = pool(
  16,
  (r) =>
    Buffer.from(hex(r, 600))
      .toString("base64")
      .slice(0, int(r, 300, 700)),
  11,
);
export const SCRATCH = pool(16, (r) => bash(r, 1_000_000), 12);
// notes as the app keeps them: under two thirds of the budget, so the
// sets a run makes still fit
export const NOTES = pool(
  32,
  (r) => {
    const entries: { topic: string; text: string }[] = [];
    for (;;) {
      const entry = {
        topic: `${pick(r, APPS)} ${pick(r, PROSE)}`.slice(
          0,
          MEMORY_TOPIC_CHARS,
        ),
        text: prose(r, int(r, 80, 400)).trim(),
      };
      if (memoryChars([...entries, entry]) > (MEMORY_CHARS * 2) / 3) break;
      entries.push(entry);
    }
    return JSON.stringify(entries);
  },
  13,
);
export const TITLES = pool(
  256,
  (r) =>
    `${pick(r, APPS)} ${pick(r, ["deploy", "rollback", "latency", "certs", "quota", "drift", "costs", "alerts", "upgrade", "backup"])} ${pick(r, ["check", "question", "review", "help", "notes", "plan", "report"])}`,
  14,
);
