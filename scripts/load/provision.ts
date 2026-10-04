// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster target's instance as provision YAML, deterministic for a
// count and a namespace: admins adm01.., members u001.. in 2 to 5 team
// projects each (every team at least 5), the fake provider, the three
// fake MCP servers, the agents on them. The users' keys are throwaway
// and made once, so the chart's Secret keeps them across installs. The
// team docs are not here: a ConfigMap is flat and capped at 1 MiB, so
// the driver's setup writes them through the API.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_NAMES } from "./catalog.ts";
import { rng } from "./random.ts";
import { FAKE, MVP } from "./shapes.ts";

export type Counts = {
  // the admins besides `admin`, which the chart makes from its key
  admins: number;
  members: number;
  teams: number;
  agents: number;
};

export const MVP_COUNTS: Counts = {
  admins: MVP.admins - 1,
  members: MVP.members,
  teams: MVP.teams,
  agents: MVP.agents,
};

const API = "apiVersion: config.1ctx.dev/v1";
const pad = (n: number, w: number) => String(n).padStart(w, "0");

export const modelUrl = (ns: string) =>
  `http://fake-model.${ns}.svc:${FAKE.modelPort}/v1`;
export const mcpBase = (ns: string) =>
  `http://fake-mcp.${ns}.svc:${FAKE.mcpPort}/`;

export function names(c: Counts) {
  return {
    admins: Array.from({ length: c.admins }, (_, i) => `adm${pad(i + 1, 2)}`),
    members: Array.from({ length: c.members }, (_, i) => `u${pad(i + 1, 3)}`),
    teams: Array.from({ length: c.teams }, (_, i) => `team${pad(i + 1, 3)}`),
    agents: Array.from({ length: c.agents }, (_, i) => `agent${pad(i + 1, 2)}`),
  };
}

// each member in 2 to 5 teams, the first by round robin so every team
// gets its share before the random picks
export function memberships(c: Counts): Map<string, string[]> {
  const n = names(c);
  const r = rng(0x6d76);
  const byTeam = new Map(n.teams.map((t) => [t, [] as string[]]));
  const [lo, hi] = MVP.teamsPerMember;
  n.members.forEach((user, i) => {
    const count = Math.min(
      n.teams.length,
      lo + Math.floor(r() * (hi - lo + 1)),
    );
    const picked = new Set([i % n.teams.length]);
    while (picked.size < count) picked.add(Math.floor(r() * n.teams.length));
    for (const t of [...picked].sort((a, b) => a - b)) {
      byTeam.get(n.teams[t]!)!.push(user);
    }
  });
  return byTeam;
}

export function provisionFiles(c: Counts, ns: string): Record<string, string> {
  const n = names(c);
  const byTeam = memberships(c);
  const user = (name: string, role: string) => `${API}
kind: User
metadata:
  name: ${name}
spec:
  role: ${role}
  fullName: Load ${name}
  email: ${name}@load.example
  tz: UTC
  passwordFrom: user-${name}
  mustChangePassword: false
`;
  const project = (t: string) => `${API}
kind: Project
metadata:
  name: ${t}
spec:
  description: Team ${t.slice(4)}.
  members: [${byTeam.get(t)!.join(", ")}]
`;
  const provider = `${API}
kind: Provider
metadata:
  name: ${FAKE.provider}
spec:
  wire: openai-compatible
  baseUrl: ${modelUrl(ns)}
  keyFrom: null
`;
  const server = (s: string) => `${API}
kind: McpServer
metadata:
  name: ${s}
spec:
  url: ${mcpBase(ns)}${s}/mcp
  keyFrom: null
  read: true
  write: true
`;
  const links = SERVER_NAMES.map(
    (s) => `    - { name: ${s}, read: true, write: true }`,
  ).join("\n");
  const agent = (a: string, i: number) => `${API}
kind: Agent
metadata:
  name: ${a}
spec:
  provider: ${FAKE.provider}
  model: ${FAKE.model}
  avatar: bot
  prompt: Answer directly and briefly.
  servers:
${links}
${i === 0 ? "  default: true\n" : ""}`;
  return {
    "users.yaml": [
      ...n.admins.map((a) => user(a, "admin")),
      ...n.members.map((m) => user(m, "member")),
    ].join("---\n"),
    "projects.yaml": n.teams.map(project).join("---\n"),
    "platform.yaml": [
      provider,
      ...SERVER_NAMES.map(server),
      ...n.agents.map(agent),
    ].join("---\n"),
  };
}

const indent = (text: string, by: number) =>
  text
    .split("\n")
    .map((line) => (line === "" ? "" : " ".repeat(by) + line))
    .join("\n");

// the chart's values: plain http inside the cluster, the provision
// files inline
export function valuesYaml(files: Record<string, string>): string {
  const inline = Object.entries(files)
    .map(([name, text]) => `    ${name}: |\n${indent(text, 6)}`)
    .join("\n");
  return `# the load harness's release, written by scripts/load/provision.ts
secureCookie: false
secrets:
  existingSecret: onectx
persistence:
  storageClass: standard
  size: 10Gi
resources:
  requests:
    cpu: "1"
    memory: 1Gi
  limits:
    cpu: "4"
    memory: 8Gi
provision:
  files:
${inline}
`;
}

// a throwaway password per user, made once; the server trims a key
// file, so none ends in a newline
export function writeSecrets(dir: string, users: string[]): number {
  mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const name of users) {
    const path = join(dir, `user-${name}.key`);
    if (existsSync(path)) continue;
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    writeFileSync(path, Buffer.from(bytes).toString("hex"), { mode: 0o600 });
    made++;
  }
  return made;
}

export function writeCluster(dir: string, ns: string, c: Counts = MVP_COUNTS) {
  const files = provisionFiles(c, ns);
  mkdirSync(join(dir, "provision"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, "provision", name), text);
  }
  writeFileSync(join(dir, "values.yaml"), valuesYaml(files));
  const n = names(c);
  const made = writeSecrets(join(dir, "secrets"), [
    "admin",
    ...n.admins,
    ...n.members,
  ]);
  return { files, made };
}
