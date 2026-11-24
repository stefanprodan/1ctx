// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Checks a sandbox image against its contract (deploy/sandbox/checks/),
// by hand (make sandbox-image-check), through a real OpenShell gateway
// and the sandbox backend, as the bash tool runs a command. Per variant
// the offline checks run in a sandbox with the network off, then the
// one online check in a sandbox on the default hosts. Every sandbox
// carries a fresh instance label and is deleted at the end.
//
//   bun scripts/sandbox-image-check.ts [--variant go] [--image <ref>] \
//     [--offline] [--endpoint <url> --ca <pem> --cert <pem> --key <pem>]
//   bun scripts/sandbox-image-check.ts --docker [--variant go|cc] \
//     [--image <ref>]
//
// With no gateway flags it uses the preview's (PREVIEW_SHELL=sandbox
// make preview): its port and the openshell- keys in .preview/secrets.
// --docker runs only the offline checks, with no gateway, in
// docker run --network none as the image's user, whose ENV is what the
// server sends; CI has no gateway. There cc, the base image's gcc
// target, is a variant too and needs --image.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ShellCall } from "../src/server/bash/index.ts";
import { wallClock } from "../src/server/lib/clock.ts";
import { logger } from "../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../src/server/limits/index.ts";
import { sandboxBackend } from "../src/server/sandbox/backend.ts";
import {
  INSTANCE_LABEL,
  Leases,
  openshellGateway,
} from "../src/server/sandbox/index.ts";
import { SHELL_VERSIONS } from "../src/server/tools/builtin/shell-tools.ts";
import {
  isSandboxVariant,
  SANDBOX_VARIANTS,
  type SandboxVariant,
} from "../src/shared/contracts/sandbox.ts";
import {
  SANDBOX_DEFAULT_HOSTS,
  type SandboxNet,
} from "../src/shared/sandbox-net.ts";

// a contract file in deploy/sandbox/checks: a variant, or cc, the base
// image's gcc target that go and rust build on
type Contract = SandboxVariant | "cc";

const ROOT = join(import.meta.dir, "..");
const CHECKS = join(ROOT, "deploy/sandbox/checks");
const SECRETS = join(ROOT, ".preview/secrets");
// a cold cargo or go build on an emulated platform takes minutes
const COMMAND_MS = 600_000;

const { values: flags } = parseArgs({
  options: {
    variant: { type: "string" },
    image: { type: "string" },
    offline: { type: "boolean", default: false },
    docker: { type: "boolean", default: false },
    endpoint: { type: "string" },
    ca: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
  },
});
function usage(): never {
  console.error(
    "usage: [--variant python|bun|go|rust] [--image <ref>, with --variant] [--offline] [--endpoint <url> --ca <pem> --cert <pem> --key <pem>]\n       --docker [--variant python|bun|go|rust|cc] [--image <ref>, with --variant; cc needs it]",
  );
  process.exit(2);
}
const one = flags.variant;
const cc = flags.docker && one === "cc";
if (one !== undefined && !cc && !isSandboxVariant(one)) usage();
if (flags.image !== undefined && one === undefined) usage();
if (cc && flags.image === undefined) usage();
const gatewayFlags = [flags.endpoint, flags.ca, flags.cert, flags.key];
if (flags.docker && gatewayFlags.some((flag) => flag !== undefined)) usage();
const variants: readonly Contract[] =
  one === undefined ? SANDBOX_VARIANTS : [one as Contract];

const instanceId = Array.from(
  crypto.getRandomValues(new Uint8Array(12)),
  (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
).join("");
const limits = { ...DEFAULT_LIMITS };
const log = logger("sandbox-image-check");
const backend = sandboxBackend({ clock: wallClock, log, limits: () => limits });
const OFF: SandboxNet = { mode: "off", hosts: [] };
const DEFAULTS: SandboxNet = {
  mode: "hosts",
  hosts: [...SANDBOX_DEFAULT_HOSTS],
};

// the contract as one command: the minors the bash tool names, the
// harness, the variant's checks, then which half to run
function script(variant: Contract, half: "offline" | "online") {
  const expect = Object.entries(SHELL_VERSIONS)
    .map(([tool, minor]) => `EXPECT_${tool.toUpperCase()}=${minor}`)
    .join(" ");
  const read = (name: string) => readFileSync(join(CHECKS, name), "utf8");
  return [
    `export ${expect}`,
    read("common.sh"),
    read(`${variant}.sh`),
    `run_${half}`,
  ].join("\n");
}

// one command of the bash tool, on a workspace with nothing mounted
async function command(leases: Leases, net: SandboxNet, text: string) {
  const call: ShellCall = {
    projectId: "image-check",
    workspace: { id: "image-check", sessionId: "image-check" },
    root: "image-check",
    sendId: crypto.randomUUID(),
    subagent: false,
    repos: [],
    repoFileBytes: 0,
    network: net.mode === "hosts",
    credentials: [],
  };
  const started = performance.now();
  const hold = await leases.acquire(
    call,
    Date.now() + COMMAND_MS,
    new AbortController().signal,
  );
  if (hold === "busy") return { ok: false, out: "no sandbox: busy", ms: 0 };
  const ran = await backend.run(
    {
      command: text,
      endsAt: Date.now() + COMMAND_MS,
      docs: true,
      visuals: true,
      network: call.network,
      cwd: "/tmp",
      knowledgeFileBytes: limits.knowledgeFileBytes,
      mountBytes: 64 << 20,
      ioBytes: 1 << 20,
      resultCut: 50_000,
      iterations: 10_000,
      knowledge: [],
      scratch: [],
      uploads: [],
      kept: [],
      repos: [],
      repoFileBytes: 0,
    },
    {
      ...call,
      mounted: {
        docs: [],
        scratch: { revision: 0, usedAt: null },
        uploads: { sessionId: "image-check", revision: 0 },
        kept: [],
      },
      hold,
    },
    { kept: () => new Uint8Array(), fetch: null },
    {
      signal: new AbortController().signal,
      deadline: new AbortController().signal,
      chat: "image-check",
    },
  );
  // nothing of a check is kept: its files live in HOME, never saved
  ran.settle({ landed: false, why: "skipped" });
  await backend.idle();
  const ms = Math.round(performance.now() - started);
  if (!ran.settled.ok)
    return { ok: false, out: ran.settled.error?.message ?? "no answer", ms };
  const { exitCode, stdout, stderr, refused, changes } = ran.settled.answer;
  // /knowledge is what a turn saves from a sandbox: a tool writing
  // there would save its cache into the project
  const saved = (changes?.knowledge ?? []).map((doc) => doc.name);
  const leak =
    saved.length === 0 ? "" : `\nwrote to /knowledge: ${saved.join(", ")}`;
  return {
    ok: exitCode === 0 && refused === null && saved.length === 0,
    out: [stdout, stderr, refused ?? "", leak].join("").trimEnd(),
    ms,
  };
}

type Gateway = ReturnType<typeof openshellGateway>;

async function checkVariant(
  gateway: Gateway,
  variant: SandboxVariant,
): Promise<boolean> {
  const image = flags.image ?? `1ctx-shell:dev-${variant}`;
  console.log(`== ${variant} (${image})`);
  let net = OFF;
  const leases = new Leases({
    clock: wallClock,
    log,
    gateway,
    instanceId,
    image,
    limits: () => limits,
    repos: { hold: () => () => {} },
    net: () => net,
  });
  let ok = true;
  try {
    for (const half of flags.offline
      ? (["offline"] as const)
      : (["offline", "online"] as const)) {
      net = half === "offline" ? OFF : DEFAULTS;
      const ran = await command(leases, net, script(variant, half));
      if (ran.out !== "") console.log(ran.out);
      console.log(`-- ${half} ${ran.ok ? "ok" : "failed"} in ${ran.ms}ms`);
      ok &&= ran.ok;
    }
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    ok = false;
  } finally {
    leases.drain();
  }
  return ok;
}

async function cleanup(gateway: Gateway) {
  const labels = { [INSTANCE_LABEL]: instanceId };
  const deadline = Date.now() + 120_000;
  for (;;) {
    // a failed list is asked again, never read as nothing left
    const left = await gateway
      .list(labels, AbortSignal.timeout(10_000))
      .catch(() => null);
    if (left?.length === 0) return true;
    if (Date.now() > deadline) {
      console.error(
        `cleanup: ${left === null ? "the sandboxes could not be listed" : `${left.map((s) => s.name).join(", ")} still listed`}`,
      );
      return false;
    }
    for (const box of left ?? [])
      await gateway
        .delete(box.name, AbortSignal.timeout(10_000))
        .catch(() => {});
    await Bun.sleep(1000);
  }
}

// the offline half, on stdin of a container with no network
async function checkDocker(variant: Contract): Promise<boolean> {
  const image = flags.image ?? `1ctx-shell:dev-${variant}`;
  console.log(`== ${variant} (${image})`);
  const started = performance.now();
  const proc = Bun.spawn(
    ["docker", "run", "--rm", "-i", "--network", "none", image, "bash"],
    {
      stdin: new TextEncoder().encode(script(variant, "offline")),
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const ok = (await proc.exited) === 0;
  const ms = Math.round(performance.now() - started);
  console.log(`-- offline ${ok ? "ok" : "failed"} in ${ms}ms`);
  return ok;
}

async function viaGateway(): Promise<string[]> {
  const pem = (flag: string | undefined, name: string) =>
    readFileSync(
      flag ?? join(SECRETS, `openshell-gateway-${name}.key`),
      "utf8",
    );
  const gateway = openshellGateway({
    endpoint:
      flags.endpoint ??
      `https://127.0.0.1:${process.env.PREVIEW_GATEWAY_PORT ?? "17671"}`,
    ca: pem(flags.ca, "ca"),
    cert: pem(flags.cert, "cert"),
    key: pem(flags.key, "key"),
  });
  const failed: string[] = [];
  try {
    for (const variant of variants)
      if (!(await checkVariant(gateway, variant as SandboxVariant)))
        failed.push(variant);
  } finally {
    if (!(await cleanup(gateway))) process.exitCode = 1;
    gateway.close();
  }
  return failed;
}

async function viaDocker(): Promise<string[]> {
  const failed: string[] = [];
  for (const variant of variants)
    if (!(await checkDocker(variant))) failed.push(variant);
  return failed;
}

const failed = flags.docker ? await viaDocker() : await viaGateway();
console.log(failed.length === 0 ? "all ok" : `failed: ${failed.join(", ")}`);
if (failed.length > 0) process.exitCode = 1;
