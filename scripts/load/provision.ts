// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster target's instance as provision YAML, deterministic for a
// count and a namespace: admins adm01.., members u001.. in 2 to 5 team
// projects each (every team at least 5), the fake provider, the three
// fake MCP servers, written in every team and read in personal projects,
// the agents on MCP. The chart's Secret holds only the first admin's key,
// which provisioning signs in with; the driver's logins are minted per
// run (logins.ts). The team docs are not
// here: a ConfigMap is flat and capped at 1 MiB, so the driver's setup
// writes them through the API.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isAdminKey, newAdminKey } from "../../src/server/users/rules.ts";
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
  const choices = n.teams
    .map((t) => `    - { project: ${t}, side: write }`)
    .join("\n");
  const server = (s: string) => `${API}
kind: McpServer
metadata:
  name: ${s}
spec:
  url: ${mcpBase(ns)}${s}/mcp
  keyFrom: null
  read: true
  write: true
  personal: read
  choices:
${choices}
`;
  const agent = (a: string, i: number) => `${API}
kind: Agent
metadata:
  name: ${a}
spec:
  provider: ${FAKE.provider}
  model: ${FAKE.model}
  avatar: bot
  prompt: Answer directly and briefly.
  mcp: true
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

export const ADMIN_KEY_FILE = "user-admin.key";

// the first admin's key, made once; a file holding anything else (an
// older harness's password) is made again, since no database keeps a key
export function writeAdminKey(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ADMIN_KEY_FILE);
  if (existsSync(path) && isAdminKey(readFileSync(path, "utf8").trim())) {
    return false;
  }
  writeFileSync(path, newAdminKey(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

// everyone the provision makes, for the logins a run mints
export function usernames(c: Counts = MVP_COUNTS): string[] {
  const n = names(c);
  return ["admin", ...n.admins, ...n.members];
}

export function writeCluster(dir: string, ns: string, c: Counts = MVP_COUNTS) {
  const files = provisionFiles(c, ns);
  mkdirSync(join(dir, "provision"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, "provision", name), text);
  }
  writeFileSync(join(dir, "values.yaml"), valuesYaml(files));
  const made = writeAdminKey(join(dir, "secrets"));
  return { files, made };
}
