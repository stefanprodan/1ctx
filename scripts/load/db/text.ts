// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The text of a built database: prose, YAML, JSON, logs, events, bash
// output and Markdown. One long text per style is made once; a body is
// a slice of it, so millions of rows cost little.

import { int, pick, type Rand as R, rng } from "../random.ts";
import { DAY, NOW } from "./presets.ts";

// the dates inside generated text, whatever the preset
const TEXT_DAYS = 395;
const TEXT_START = NOW - TEXT_DAYS * DAY;

export const hex = (r: R, n: number) => {
  let o = "";
  for (let i = 0; i < n; i++) o += "0123456789abcdef"[Math.floor(r() * 16)];
  return o;
};
export const APPS = [
  "payments",
  "ledger",
  "checkout",
  "accounts",
  "cards",
  "fraud",
  "kyc",
  "loans",
  "fx",
  "treasury",
  "notify",
  "search",
  "gateway",
  "identity",
  "audit",
  "reports",
  "billing",
  "mortgage",
  "savings",
  "risk",
  "pricing",
  "trading",
  "custody",
  "clearing",
  "statements",
];
export const AREAS = ["api", "platform", "data", "ops"];
export const NS = APPS.map((a) => `${a}-prod`);
export const PROSE =
  "the controller reconciles the release every five minutes and reports drift when the live object differs from the desired state check the events in the namespace before a restart and compare the revision with the source the alert fires when latency stays above the budget for ten minutes and pages the on call engineer who owns the service the pod was killed because the memory limit is below the working set of the cache so raise the limit or shrink the cache and roll the deployment again".split(
    " ",
  );
export const iso = (t: number) => new Date(t).toISOString();

export function prose(r: R, n: number): string {
  let o = "";
  let k = Math.floor(r() * PROSE.length);
  while (o.length < n) {
    const len = int(r, 8, 22);
    const words: string[] = [];
    for (let w = 0; w < len; w++) words.push(PROSE[k++ % PROSE.length]!);
    if (r() < 0.3) k = Math.floor(r() * PROSE.length);
    o += `${words.join(" ")}. `;
    if (r() < 0.2) o += "\n\n";
  }
  return o.slice(0, n);
}
function yaml(r: R, n: number): string {
  let o = "apiVersion: v1\nitems:\n";
  while (o.length < n) {
    const app = pick(r, APPS);
    const ns = `${app}-prod`;
    const name = `${app}-${pick(r, AREAS)}-${hex(r, 9)}-${hex(r, 5)}`;
    const t = TEXT_START + Math.floor(r() * TEXT_DAYS * DAY);
    o += `- apiVersion: ${pick(r, ["apps/v1", "v1", "helm.toolkit.fluxcd.io/v2", "kustomize.toolkit.fluxcd.io/v1"])}
  kind: ${pick(r, ["Deployment", "Pod", "HelmRelease", "Kustomization", "Service", "ConfigMap"])}
  metadata:
    name: ${name}
    namespace: ${ns}
    uid: ${hex(r, 8)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 12)}
    resourceVersion: "${int(r, 1_000_000, 99_999_999)}"
    generation: ${int(r, 1, 400)}
    creationTimestamp: "${iso(t)}"
    labels:
      app.kubernetes.io/name: ${app}
      app.kubernetes.io/version: ${int(r, 1, 9)}.${int(r, 0, 40)}.${int(r, 0, 99)}
      pod-template-hash: ${hex(r, 10)}
    annotations:
      fluxcd.io/revision: main@sha1:${hex(r, 40)}
  spec:
    replicas: ${int(r, 1, 12)}
    image: registry.load.example/${app}:${int(r, 1, 9)}.${int(r, 0, 40)}.${int(r, 0, 99)}
    resources:
      limits: {cpu: "${int(r, 1, 8)}", memory: ${int(r, 1, 16) * 256}Mi}
  status:
    conditions:
    - type: ${pick(r, ["Ready", "Available", "Progressing", "Reconciling"])}
      status: "${pick(r, ["True", "True", "True", "False"])}"
      reason: ${pick(r, ["ReconciliationSucceeded", "MinimumReplicasAvailable", "ProgressDeadlineExceeded", "OOMKilled", "UpgradeFailed"])}
      lastTransitionTime: "${iso(t + int(r, 0, 9e8))}"
      message: ${prose(r, int(r, 30, 120)).replace(/\n/g, " ")}
    restartCount: ${int(r, 0, 60)}
`;
  }
  return o.slice(0, n);
}
function json(r: R, n: number): string {
  let o = "[";
  while (o.length < n) {
    o += `{"id":"${pick(r, APPS)}/${hex(r, 8)}","name":"${pick(r, APPS)} ${pick(r, AREAS)} ${int(r, 1, 400)}","created":${int(r, 1.7e9, 1.8e9)},"context_length":${pick(r, [32768, 131072, 262144, 1048576])},"pricing":{"prompt":"0.000000${int(r, 10, 99)}","completion":"0.00000${int(r, 100, 999)}"},"sha":"${hex(r, 40)}","description":"${prose(r, int(r, 40, 200)).replace(/\n/g, " ")}"},\n`;
  }
  return `${o.slice(0, n - 1)}]`;
}
export function logs(r: R, n: number): string {
  let o = "";
  let t = TEXT_START + Math.floor(r() * TEXT_DAYS * DAY);
  while (o.length < n) {
    t += int(r, 1, 900);
    o += `${iso(t)} level=${pick(r, ["info", "info", "info", "warn", "error"])} logger=${pick(r, APPS)}.${pick(r, ["http", "db", "cache", "queue", "grpc"])} msg="${pick(r, ["request served", "upstream timeout", "retrying", "connection reset by peer", "slow query", "cache miss", "reconcile finished", "context deadline exceeded"])}" request_id=${hex(r, 16)} trace_id=${hex(r, 32)} latency_ms=${int(r, 1, 9000)} status=${pick(r, [200, 200, 200, 201, 404, 500, 502, 503])} path=/api/v${int(r, 1, 3)}/${pick(r, APPS)}/${hex(r, 6)}\n`;
  }
  return o.slice(0, n);
}
function events(r: R, n: number): string {
  let o =
    "LAST SEEN   TYPE      REASON              OBJECT                                   MESSAGE\n";
  while (o.length < n) {
    o += `${int(r, 1, 59)}${pick(r, ["s", "m", "h"])}   ${pick(r, ["Normal ", "Warning"])}   ${pick(r, ["BackOff", "Pulled", "Killing", "Unhealthy", "FailedScheduling", "ReconciliationFailed", "Scheduled", "OOMKilling"]).padEnd(20)}pod/${pick(r, APPS)}-${hex(r, 9)}-${hex(r, 5)}   ${prose(r, int(r, 30, 110)).replace(/\n/g, " ")}\n`;
  }
  return o.slice(0, n);
}
export function bash(r: R, n: number): string {
  let o = "";
  while (o.length < n) {
    const kind = r();
    if (kind < 0.4) {
      o += `/knowledge/runbooks/svc-${String(int(r, 0, 149)).padStart(3, "0")}.md:${int(r, 1, 900)}:${prose(r, int(r, 40, 140)).replace(/\n/g, " ")}\n`;
    } else if (kind < 0.7) {
      o += `/mcp/${String(int(r, 1, 40)).padStart(4, "0")}-get_kubernetes_logs/result.txt:${int(r, 1, 4000)}:${logs(r, int(r, 120, 220)).split("\n")[0]}\n`;
    } else {
      o += `${pick(r, APPS)}-${hex(r, 9)}-${hex(r, 5)}   ${int(r, 0, 3)}/${int(r, 1, 3)}   ${pick(r, ["Running", "Running", "CrashLoopBackOff", "OOMKilled", "Pending"])}   ${int(r, 0, 60)}   ${int(r, 1, 59)}${pick(r, ["m", "h", "d"])}\n`;
    }
  }
  return o.slice(0, n);
}
export function markdown(r: R, n: number): string {
  let o = `# ${pick(r, APPS)} ${pick(r, ["runbook", "skill", "incident review", "reference"])}\n\n`;
  let s = 0;
  while (o.length < n) {
    o += `## ${++s}. ${pick(r, PROSE)} ${pick(r, PROSE)}\n\n${prose(r, int(r, 200, 900))}\n\n`;
    if (r() < 0.4)
      o += `\`\`\`sh\nkubectl -n ${pick(r, NS)} get events | grep -i ${pick(r, PROSE)}\n\`\`\`\n\n`;
  }
  return o.slice(0, n);
}

export type Style =
  | "prose"
  | "yaml"
  | "json"
  | "logs"
  | "events"
  | "bash"
  | "markdown";
const STYLES: Record<Style, (r: R, n: number) => string> = {
  prose,
  yaml,
  json,
  logs,
  events,
  bash,
  markdown,
};
// one long text per style; bodies are slices of it
const BASE_CHARS = 1_600_000;
let bases: Record<Style, string> | null = null;
function basesOf(): Record<Style, string> {
  bases ??= Object.fromEntries(
    (Object.keys(STYLES) as Style[]).map((s, i) => [
      s,
      STYLES[s](rng(0xba5e + i), BASE_CHARS),
    ]),
  ) as Record<Style, string>;
  return bases;
}
export function slice(r: R, style: Style, n: number): string {
  const base = basesOf()[style];
  const at = Math.floor(r() * (base.length - n));
  return base.slice(at, at + n);
}
