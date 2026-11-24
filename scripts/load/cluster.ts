// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster target: the Helm chart's pod on a local kind cluster, the
// fakes beside it, the driver in a pod, nothing through a port-forward.
// Only a context named kind-* is used, and only a namespace named 1ctx-*.
// Before each driver pod the server stops, a pod mints a login per user
// into its database from hashes, and the tokens go into a Secret that
// only the driver mounts.
//
//   bun scripts/load/cluster.ts install [--tag dev] [--cpu 4]
//   bun scripts/load/cluster.ts setup [--max-mult 16]
//   bun scripts/load/cluster.ts step MULT MINUTES [--label NAME] [--incident]
//     [--caps default|max]
//   bun scripts/load/cluster.ts smoke        (install, setup, step 1 5)
// every command: [--context kind-1ctx-test] [--namespace 1ctx-load]
// `make kind-up` makes that cluster, `make kind-image` loads the image

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUT_DIR } from "./db/build.ts";
import { type CapsMode, parseCaps } from "./driver/automations.ts";
import {
  Cancelled,
  ended,
  type Kube,
  LOGINS_SECRET,
  mint as mint_,
  RecoveryFailed,
} from "./pods.ts";
import {
  ADMIN_KEY_FILE,
  mcpBase,
  modelUrl,
  usernames,
  writeCluster,
} from "./provision.ts";
import { rolledOut } from "./rollout.ts";
import { FAKE } from "./shapes.ts";
import { printTable, summarize } from "./summarize.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLUSTER = join(OUT_DIR, "cluster");
const BUN_IMAGE = "oven/bun:1.4.4";
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
);

export function checkTarget(context: string, ns: string) {
  if (!context.startsWith("kind-"))
    throw new Error(`refusing context ${context}: only kind-* contexts`);
  if (!ns.startsWith("1ctx-"))
    throw new Error(`refusing namespace ${ns}: only 1ctx-* namespaces`);
}

// a kind cluster serves its API on the machine itself; a context named
// kind-* that points anywhere else is not one
export function checkServer(context: string, server: string) {
  let host = "";
  try {
    host = new URL(server).hostname;
  } catch {}
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(
      `refusing context ${context}: its API server ${server || "(none)"} is not on loopback`,
    );
  }
}

const context = flag("context") ?? "kind-1ctx-test";
const ns = flag("namespace") ?? "1ctx-load";

function run(cmd: string[], input?: string, quiet = false): string {
  const p = Bun.spawnSync(cmd, {
    cwd: ROOT,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
  });
  const out = p.stdout.toString();
  if (p.exitCode !== 0)
    throw new Error(
      `${cmd.slice(0, 4).join(" ")}: ${p.stderr.toString().trim()}`,
    );
  if (!quiet && out.trim() !== "") console.log(out.trim());
  return out;
}
const k = (...args: string[]) => [
  "kubectl",
  "--context",
  context,
  "-n",
  ns,
  ...args,
];
const apply = (yaml: string) => run(k("apply", "-f", "-"), yaml, true);

function fakes(): string {
  const one = (
    name: string,
    script: string,
    port: number,
  ) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name}, namespace: ${ns} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata: { labels: { app: ${name} } }
    spec:
      containers:
        - name: ${name}
          image: ${BUN_IMAGE}
          command: ["bun", "/load/${script}"]
          env:
            - { name: PORT, value: "${port}" }
            - { name: HOST, value: "0.0.0.0" }
          ports: [{ containerPort: ${port} }]
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { cpu: "2", memory: 1Gi }
          volumeMounts: [{ name: scripts, mountPath: /load }]
      volumes: [{ name: scripts, configMap: { name: load-scripts } }]
---
apiVersion: v1
kind: Service
metadata: { name: ${name}, namespace: ${ns} }
spec:
  selector: { app: ${name} }
  ports: [{ port: ${port}, targetPort: ${port} }]
`;
  return `${one("fake-model", "fake-model.js", FAKE.modelPort)}---\n${one("fake-mcp", "fake-mcp.js", FAKE.mcpPort)}`;
}

function driverPod(name: string, args: string[]): string {
  return `apiVersion: v1
kind: Pod
metadata: { name: ${name}, namespace: ${ns} }
spec:
  restartPolicy: Never
  containers:
    - name: run
      image: ${BUN_IMAGE}
      command: ${JSON.stringify(["bun", "/load/driver.js", ...args])}
      env:
        - { name: BASE, value: "http://onectx.${ns}.svc" }
        - { name: LOGINS, value: /logins/logins.json }
        - { name: FAKE_MODEL_URL, value: "${modelUrl(ns)}" }
        - { name: FAKE_MCP_URL, value: "${mcpBase(ns)}" }
      resources:
        requests: { cpu: 250m, memory: 256Mi }
        limits: { cpu: "2", memory: 2Gi }
      volumeMounts:
        - { name: scripts, mountPath: /load }
        - { name: logins, mountPath: /logins, readOnly: true }
  volumes:
    - { name: scripts, configMap: { name: load-scripts } }
    - { name: logins, secret: { secretName: ${LOGINS_SECRET} } }
`;
}

// one file per entry, so the pods need nothing but Bun
async function scripts() {
  const dir = join(CLUSTER, "bundle");
  const entries: [string, string][] = [
    ["scripts/load/fake-model.ts", "fake-model.js"],
    ["scripts/load/fake-mcp.ts", "fake-mcp.js"],
    ["scripts/load/driver/main.ts", "driver.js"],
    ["scripts/load/mint.ts", "mint.js"],
  ];
  for (const [entry, file] of entries) {
    const built = await Bun.build({
      entrypoints: [join(ROOT, entry)],
      target: "bun",
      outdir: dir,
      naming: file,
    });
    if (!built.success)
      throw new Error(`bundle ${entry}: ${built.logs.join("; ")}`);
  }
  const files = entries.flatMap(([, file]) => [
    `--from-file=${join(dir, file)}`,
  ]);
  apply(
    run(
      k(
        "create",
        "configmap",
        "load-scripts",
        ...files,
        "--dry-run=client",
        "-o",
        "yaml",
      ),
      undefined,
      true,
    ),
  );
}

// the database keeps no admin key, so a fresh one works on an existing
// namespace; the Secret holds that file alone, never older ones beside it
async function install() {
  const { made } = writeCluster(CLUSTER, ns);
  console.log(
    `provision written to ${CLUSTER}${made ? ", a new admin key" : ""}`,
  );
  apply(
    run(
      [
        "kubectl",
        "--context",
        context,
        "create",
        "namespace",
        ns,
        "--dry-run=client",
        "-o",
        "yaml",
      ],
      undefined,
      true,
    ),
  );
  apply(
    run(
      k(
        "create",
        "secret",
        "generic",
        "onectx",
        `--from-file=${ADMIN_KEY_FILE}=${join(CLUSTER, "secrets", ADMIN_KEY_FILE)}`,
        "--dry-run=client",
        "-o",
        "yaml",
      ),
      undefined,
      true,
    ),
  );
  await scripts();
  apply(fakes());
  run(
    k("rollout", "restart", "deploy/fake-model", "deploy/fake-mcp"),
    undefined,
    true,
  );
  await rolledOut(k, "fake-model");
  await rolledOut(k, "fake-mcp");
  const tag = flag("tag") ?? "dev";
  run(
    [
      "helm",
      "upgrade",
      "--install",
      "onectx",
      "deploy/charts/onectx",
      "--kube-context",
      context,
      "-n",
      ns,
      "-f",
      join(CLUSTER, "values.yaml"),
      "--set",
      `image.tag=${tag}`,
      "--set",
      `resources.limits.cpu=${flag("cpu") ?? "4"}`,
    ],
    undefined,
    true,
  );
  // a rebuilt image keeps the dev tag, so helm sees no change and the
  // old pod would keep running the previous build
  run(k("rollout", "restart", "deploy/onectx"), undefined, true);
  await rolledOut(k, "onectx");
  console.log(`installed onectx in ${context}/${ns}`);
}

// the CPU and RSS columns come from kubectl top; without metrics-server
// they would be empty with no word why, so a step refuses to start
function checkMetrics() {
  // nodes, since the namespace may not exist before install
  const p = Bun.spawnSync([
    "kubectl",
    "--context",
    context,
    "top",
    "node",
    "--no-headers",
  ]);
  if (p.exitCode !== 0) {
    throw new Error(
      `kubectl top fails on ${context} (metrics-server missing or not ready; make kind-up installs it): ${p.stderr.toString().trim()}`,
    );
  }
}

// SIGINT or SIGTERM sets it, so the waits throw and every cleanup runs
let cancelRequested = false;
const kube: Kube = {
  k,
  sleep: (ms) => Bun.sleep(ms),
  cancelled: () => cancelRequested,
};
const mint = () => mint_(kube, usernames(), ns, BUN_IMAGE);

// runs the driver in a fresh pod and returns its log, or throws with
// the log printed unless it succeeded; mint() goes first
async function driver(
  name: string,
  args: string[],
  doneMs: number,
): Promise<string> {
  run(k("delete", "pod", name, "--ignore-not-found"), undefined, true);
  apply(driverPod(name, args));
  let phase: string;
  try {
    phase = await ended(kube, name, doneMs);
  } catch (e) {
    if (e instanceof Cancelled) {
      Bun.spawnSync(k("delete", "pod", name, "--wait=false"));
    }
    throw e;
  }
  const log = run(k("logs", name), undefined, true);
  if (phase !== "Succeeded") {
    console.log(log);
    throw new Error(`pod ${name} ended ${phase}`);
  }
  return log;
}

// a step: its minutes, the schedules set before it, the tail and the
// read back after it
const stepMs = (minutes: number) => (minutes + 30) * 60_000;
const SETUP_MS = 120 * 60_000;

// every process this run started, stopped on any exit
const children = new Set<Bun.Subprocess>();
const stopChildren = () => {
  for (const c of children) c.kill();
  children.clear();
};
// a first signal stops the children and cancels the waits, so the mint
// step scales the server back; a second exits at once
function stopOnExit() {
  process.on("exit", stopChildren);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (cancelRequested) process.exit(130);
      cancelRequested = true;
      console.error("stopping: cleaning up first, again to exit now");
      stopChildren();
    });
  }
}

async function step(mult: string, minutes: string, caps?: CapsMode) {
  const label = flag("label") ?? `cluster-step-${mult}x`;
  const results = join(OUT_DIR, "results", label);
  mkdirSync(results, { recursive: true });
  await scripts();
  // before the log followers, since it replaces the server's pod
  await mint();
  await Bun.write(
    join(results, "meta.json"),
    `${JSON.stringify({ target: "cluster", label, context, namespace: ns, mult: Number(mult), minutes: Number(minutes), at: new Date().toISOString() }, null, 2)}\n`,
  );
  // streamed, since the kubelet rotates a busy container's log mid-step
  const follow = (what: string, file: string) =>
    Bun.spawn(k("logs", "-f", what, "--since=1s"), {
      cwd: ROOT,
      stdout: Bun.file(join(results, file)),
      stderr: "ignore",
    });
  const followers: Bun.Subprocess[] = [];
  const top: string[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    for (const [what, file] of [
      ["deploy/onectx", "server.log"],
      ["deploy/fake-model", "model.log"],
      ["deploy/fake-mcp", "mcp.log"],
    ] as const) {
      const f = follow(what, file);
      followers.push(f);
      children.add(f);
    }
    sampler = setInterval(() => {
      const p = Bun.spawnSync(k("top", "pod", "--no-headers"));
      const m = p.stdout.toString().match(/onectx-\S+\s+(\d+)m\s+(\d+)Mi/);
      if (m)
        top.push(
          JSON.stringify({
            t: "top",
            at: Date.now(),
            cpuM: Number(m[1]),
            memMi: Number(m[2]),
          }),
        );
    }, 5000);
    const args = [
      "step",
      mult,
      minutes,
      ...(argv.includes("--incident") ? ["--incident"] : []),
      ...(caps === undefined ? [] : ["--caps", caps]),
    ];
    await Bun.write(
      join(results, "driver.log"),
      await driver(
        `driver-${label}`.slice(0, 63),
        args,
        stepMs(Number(minutes)),
      ),
    );
  } finally {
    clearInterval(sampler);
    for (const f of followers) {
      f.kill();
      children.delete(f);
    }
    await Bun.write(join(results, "top.log"), `${top.join("\n")}\n`);
  }
  printTable([await summarize(results)]);
  // a step with no samples or no fake model log would print empty
  // columns that read as a result
  if (top.length === 0) {
    throw new Error(
      `no CPU or memory samples: kubectl top pod never showed the server pod in ${ns}`,
    );
  }
  if (Bun.file(join(results, "model.log")).size === 0) {
    throw new Error("the fake model's log is empty: no server gap measured");
  }
}

async function main() {
  // a typo fails before any cluster is touched
  const caps = parseCaps(argv);
  checkTarget(context, ns);
  stopOnExit();
  const contexts = run(
    ["kubectl", "config", "get-contexts", "-o", "name"],
    undefined,
    true,
  ).split("\n");
  if (!contexts.includes(context)) throw new Error(`no context ${context}`);
  const server = run(
    [
      "kubectl",
      "config",
      "view",
      "--context",
      context,
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ],
    undefined,
    true,
  ).trim();
  checkServer(context, server);
  const [command, a, b] = positional;
  if (command === "step" || command === "smoke") checkMetrics();
  if (command === "install") await install();
  else if (command === "setup") {
    await scripts();
    await mint();
    console.log(
      await driver(
        "driver-setup",
        ["setup", "--max-mult", flag("max-mult") ?? "16"],
        SETUP_MS,
      ),
    );
  } else if (command === "step" && a && b) await step(a, b, caps);
  else if (command === "smoke") {
    await install();
    await mint();
    console.log(
      await driver(
        "driver-setup",
        ["setup", "--max-mult", "1", "--docs", "20"],
        SETUP_MS,
      ),
    );
    await step("1", "5");
  } else {
    console.error(
      "usage: cluster.ts install|setup|step MULT MINUTES|smoke [--context kind-*] [--namespace 1ctx-*]",
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    if (cancelRequested && !(e instanceof RecoveryFailed)) process.exit(130);
    throw e;
  }
}
