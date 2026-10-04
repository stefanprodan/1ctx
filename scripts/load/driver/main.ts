// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The load against a running server, on either target: the local
// target runs it on the machine, the kind target in a pod beside the
// server. Every line on stdout is one JSON event.
//
//   bun scripts/load/driver/main.ts setup [--max-mult M] [--docs N] [--parallel P]
//   bun scripts/load/driver/main.ts step MULT MINUTES [--seed S] [--incident]
//   bun scripts/load/driver/main.ts turns N SECONDS [--seed S] [--tool-share X]
//
// env: BASE (the server), ADMIN (admin), PASSWORD (one for every user)
// or SECRETS (a folder of user-<name>.key, /secrets/), FAKE_MODEL_URL
// and FAKE_MCP_URL (what every provider and MCP server must point at)

import type { ProjectsResponse } from "../../../src/shared/api/projects.ts";
import { KNOWLEDGE_FILES } from "../shapes.ts";
import { Api } from "./api.ts";
import { assertFenced, fenceWeb, loadDirectory } from "./directory.ts";
import { step } from "./hour.ts";
import { failure } from "./log.ts";
import { setup } from "./setup.ts";
import { turns } from "./turns.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
);
const usage =
  "usage: main.ts setup [--max-mult M] [--docs N] [--parallel P] | step MULT MINUTES [--seed S] [--incident] | turns N SECONDS [--seed S] [--tool-share X]";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

async function main() {
  const command = positional[0];
  if (command !== "setup" && command !== "step" && command !== "turns") {
    console.error(usage);
    process.exit(2);
  }
  const api = new Api({
    base: env("BASE"),
    password: process.env.PASSWORD,
    secrets: process.env.SECRETS,
  });
  const admin = await api.signIn(process.env.ADMIN ?? "admin", 0);
  // the fence, read back before any load
  await fenceWeb(api, admin);
  await assertFenced(api, admin, env("FAKE_MODEL_URL"), env("FAKE_MCP_URL"));
  const d = await loadDirectory(api, admin);
  const projects = await api.must<ProjectsResponse>(
    admin,
    "GET",
    "/api/projects",
  );
  const personal = projects.projects.find((p) => p.kind === "personal");
  if (personal === undefined)
    throw new Error("the admin has no personal project");
  const a = Number(positional[1]);
  const b = Number(positional[2]);
  if (command === "setup") {
    await setup(api, admin, d, {
      maxMult: flag("max-mult", 1),
      docs: flag("docs", KNOWLEDGE_FILES),
      parallel: flag("parallel", 4),
    });
    return;
  }
  if (!(a > 0) || !(b > 0)) throw new Error(usage);
  if (command === "step") {
    await step(api, admin, d, {
      mult: a,
      minutes: b,
      seed: flag("seed", a * 7919 + b),
      incident: argv.includes("--incident"),
      personal: personal.id,
    });
    return;
  }
  await turns(api, admin, d, {
    n: a,
    seconds: b,
    seed: flag("seed", 0x5eed0000 + a),
    toolShare: flag("tool-share", 0.25),
    personal: personal.id,
  });
}

try {
  await main();
} catch (e) {
  failure("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
process.exit(0);
