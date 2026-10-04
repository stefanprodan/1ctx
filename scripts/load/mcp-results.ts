// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the fake MCP tools answer: text made from the tool and its
// arguments, so a call repeats. Logs, events, YAML, JSON items or
// Markdown by tool, sized by MCP_RESULT.

import { words } from "./catalog.ts";
import { canonical, hash32, pick, type Rand, rng } from "./random.ts";
import { MCP_RESULT as R } from "./shapes.ts";

const NS = [
  "flux-system",
  "apps",
  "monitoring",
  "ingress",
  "payments",
  "search",
  "auth",
  "data",
];
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
const REASONS = [
  "OOMKilled",
  "CrashLoopBackOff",
  "ProbeFailed",
  "ReconciliationFailed",
  "HealthCheckFailed",
  "Progressing",
  "ArtifactUpToDate",
  "DependencyNotReady",
];
const LEVELS = ["info", "info", "info", "warn", "error", "debug"];

// mostly 0.1 to 7 KB, ~10% 14 to 23 KB; large 60 to 200 KB
export function resultBytes(r: Rand, large: boolean): number {
  const span = ([lo, hi]: readonly number[]) => [lo!, hi! - lo!] as const;
  if (large) {
    const [lo, d] = span(R.large);
    return Math.floor(lo + r() * d);
  }
  if (r() < R.tailShare) {
    const [lo, d] = span(R.tail);
    return Math.floor(lo + r() * d);
  }
  const [lo, d] = span(R.small);
  return Math.floor(lo + r() ** 2 * d);
}

function ts(r: Rand, i: number): string {
  const s = 3600 * 9 + i * 7 + Math.floor(r() * 5);
  const hh = String(Math.floor(s / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `2026-10-02T${hh}:${mm}:${ss}Z`;
}

function logLines(r: Rand, bytes: number): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `${ts(r, i)} level=${pick(r, LEVELS)} app=${pick(r, APPS)} msg="${pick(r, ["request served", "reconcile finished", "upstream timeout", "retrying", "cache miss", "out of memory", "connection reset"])}" duration=${Math.floor(r() * 900)}ms status=${pick(r, [200, 200, 200, 404, 500, 503])}`;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function eventLines(r: Rand, bytes: number): string {
  const out = [
    "LAST SEEN   TYPE      REASON                 OBJECT                       MESSAGE",
  ];
  let size = out[0]!.length;
  while (size < bytes) {
    const line = `${Math.floor(r() * 59)}m         ${pick(r, ["Normal ", "Warning"])}   ${pick(r, REASONS).padEnd(22)} ${`helmrelease/${pick(r, APPS)}`.padEnd(28)} ${pick(r, ["Back-off restarting failed container", "Helm upgrade succeeded", "health check failed after 5m0s", "Reconciliation finished in 1.2s", "Readiness probe failed: HTTP 503"])}`;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function yamlDocs(r: Rand, bytes: number, kind: string): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const app = pick(r, APPS);
    const ready = r() < 0.8;
    const doc = [
      "---",
      `apiVersion: ${kind === "HelmRelease" ? "helm.toolkit.fluxcd.io/v2" : "kustomize.toolkit.fluxcd.io/v1"}`,
      `kind: ${kind}`,
      "metadata:",
      `  name: ${app}-${i}`,
      `  namespace: ${pick(r, NS)}`,
      "  labels:",
      `    app.kubernetes.io/name: ${app}`,
      `    kustomize.toolkit.fluxcd.io/name: ${pick(r, ["apps", "infra", "tenants"])}`,
      "spec:",
      `  interval: ${pick(r, ["1m", "5m", "10m", "1h"])}`,
      `  timeout: ${pick(r, ["3m", "5m"])}`,
      "status:",
      "  conditions:",
      `  - type: Ready`,
      `    status: "${ready ? "True" : "False"}"`,
      `    reason: ${ready ? "ReconciliationSucceeded" : pick(r, REASONS)}`,
      `    message: ${ready ? "Release reconciliation succeeded" : "health check failed after 5m0s: timeout waiting for Deployment"}`,
      `    lastTransitionTime: "${ts(r, i)}"`,
      `  lastAppliedRevision: ${Math.floor(r() * 9)}.${Math.floor(r() * 20)}.${Math.floor(r() * 9)}`,
    ].join("\n");
    out.push(doc);
    size += doc.length + 1;
  }
  return out.join("\n");
}

function jsonItems(r: Rand, bytes: number, tool: string): string {
  const items: Record<string, unknown>[] = [];
  let size = 2;
  for (let i = 0; size < bytes; i++) {
    const item = tool.includes("commit")
      ? {
          sha: (
            hash32(`${i}${r()}`).toString(16) + hash32(`${r()}`).toString(16)
          ).padEnd(16, "0"),
          author: pick(r, ["dev01", "dev02", "dev05", "dev07"]),
          date: ts(r, i),
          message: `${pick(r, ["fix", "feat", "chore"])}(${pick(r, APPS)}): ${pick(r, ["bump chart", "raise memory limit", "retry on 503", "pin image digest"])}`,
        }
      : tool.includes("pull") || tool.includes("issue")
        ? {
            number: 100 + Math.floor(r() * 900),
            title: `${pick(r, APPS)}: ${pick(r, ["memory leak under load", "timeout talking to ledger", "upgrade to v2", "flaky e2e"])}`,
            state: pick(r, ["open", "closed", "merged"]),
            user: pick(r, ["dev01", "dev04", "dev03"]),
            labels: [pick(r, ["bug", "infra", "release"])],
            updated_at: ts(r, i),
          }
        : {
            path: `charts/${pick(r, APPS)}/${pick(r, ["values.yaml", "Chart.yaml", "templates/deployment.yaml"])}`,
            repo: `platform/${pick(r, APPS)}`,
            ref: pick(r, ["main", "v1.4.2", "release-2"]),
            line: Math.floor(r() * 400),
            text: `  resources: { limits: { memory: ${pick(r, ["256Mi", "512Mi", "1Gi"])} } }`,
          };
    items.push(item);
    const pretty = JSON.stringify(item, null, 1);
    size += pretty.length + pretty.split("\n").length + 2;
  }
  return JSON.stringify({ total_count: items.length, items }, null, 1);
}

function markdown(r: Rand, bytes: number, tool: string): string {
  const out = [`# ${words(tool)}`, ""];
  let size = out[0]!.length;
  for (let i = 1; size < bytes; i++) {
    const p = [
      `## ${i}. ${pick(r, ["HelmRelease", "Kustomization", "OCIRepository", "remediation", "drift detection", "health checks"])}`,
      "",
      `The controller ${pick(r, ["retries the upgrade", "reconciles the object", "waits for the health checks", "rolls back the release"])} when ${pick(r, ["the timeout passes", "a dependency is not ready", "the source revision changes", "drift is detected"])}. Set \`spec.${pick(r, ["interval", "timeout", "install.remediation.retries", "upgrade.cleanupOnFail"])}\` to change it.`,
      "",
    ].join("\n");
    out.push(p);
    size += p.length + 1;
  }
  return out.join("\n");
}

export function resultText(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const r = rng(hash32(`body\n${server}\n${tool}\n${canonical(args)}`));
  const bytes = resultBytes(r, args.size === "large");
  let text: string;
  if (server === "git")
    text = tool.includes("logs")
      ? logLines(r, bytes)
      : jsonItems(r, bytes, tool);
  else if (server === "docs") text = markdown(r, bytes, tool);
  else if (tool.includes("logs")) text = logLines(r, bytes);
  else if (tool.includes("events")) text = eventLines(r, bytes);
  else if (tool.includes("docs")) text = markdown(r, bytes, tool);
  else
    text = yamlDocs(
      r,
      bytes,
      tool.includes("helm") || r() < 0.5 ? "HelmRelease" : "Kustomization",
    );
  return text;
}
