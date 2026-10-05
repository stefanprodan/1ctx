// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster target: the Helm chart's pod on a local kind cluster, the
// fakes beside it, the driver in a pod, nothing through a port-forward.
// Only a context named kind-* is used, and only a namespace named 1ctx-*.
//
//   bun scripts/load/cluster.ts install [--tag dev] [--cpu 4]
//   bun scripts/load/cluster.ts setup [--max-mult 16]
//   bun scripts/load/cluster.ts step MULT MINUTES [--label NAME] [--incident]
//     [--caps default|max]
//   bun scripts/load/cluster.ts smoke        (install, setup, step 1 5)
// every command: [--context kind-1ctx-test] [--namespace 1ctx-load]
// `make kind-up` makes that cluster, `make kind-image` loads the image

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUT_DIR } from "./db/build.ts";
import { type CapsMode, parseCaps } from "./driver/automations.ts";
import { mcpBase, modelUrl, writeCluster } from "./provision.ts";
import { failIfStuck, rolledOut } from "./rollout.ts";
import { FAKE } from "./shapes.ts";
import { printTable, summarize } from "./summarize.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLUSTER = join(OUT_DIR, "cluster");
const BUN_IMAGE = "oven/bun:1.4.2";
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
        - { name: SECRETS, value: /secrets/ }
        - { name: FAKE_MODEL_URL, value: "${modelUrl(ns)}" }
        - { name: FAKE_MCP_URL, value: "${mcpBase(ns)}" }
      resources:
        requests: { cpu: 250m, memory: 256Mi }
        limits: { cpu: "2", memory: 2Gi }
      volumeMounts:
        - { name: scripts, mountPath: /load }
        - { name: secrets, mountPath: /secrets, readOnly: true }
  volumes:
    - { name: scripts, configMap: { name: load-scripts } }
    - { name: secrets, secret: { secretName: onectx } }
`;
}

// one file per entry, so the pods need nothing but Bun
async function scripts() {
  const dir = join(CLUSTER, "bundle");
  const entries: [string, string][] = [
    ["scripts/load/fake-model.ts", "fake-model.js"],
    ["scripts/load/fake-mcp.ts", "fake-mcp.js"],
    ["scripts/load/driver/main.ts", "driver.js"],
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

// the namespace's database was provisioned with its Secret's keys, so
// those win over the local folder: fresh local keys would lock the
// server out of its own users and crash it on every start
export function restoreKeys(
  kubectl: (...args: string[]) => string[],
  dir: string,
): number {
  const p = Bun.spawnSync(kubectl("get", "secret", "onectx", "-o", "json"));
  if (p.exitCode !== 0) {
    const err = p.stderr.toString();
    // a fresh namespace has no Secret yet and gets fresh keys
    if (err.includes("NotFound") || err.includes("not found")) return 0;
    throw new Error(`reading the namespace's keys: ${err.trim()}`);
  }
  const data =
    (JSON.parse(p.stdout.toString()) as { data?: Record<string, string> })
      .data ?? {};
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(data)) {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(value, "base64"));
    chmodSync(path, 0o600);
  }
  return Object.keys(data).length;
}

async function install() {
  const restored = restoreKeys(k, join(CLUSTER, "secrets"));
  if (restored > 0) console.log(`${restored} keys taken from the namespace`);
  const { made } = writeCluster(CLUSTER, ns);
  console.log(`provision written to ${CLUSTER}, ${made} new keys`);
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
        `--from-file=${join(CLUSTER, "secrets")}`,
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

// runs the driver in a fresh pod and returns its log; the pod must
// start within READY_MS and end within doneMs, or the run fails
const READY_MS = 3 * 60_000;
async function driver(
  name: string,
  args: string[],
  doneMs: number,
): Promise<string> {
  run(k("delete", "pod", name, "--ignore-not-found"), undefined, true);
  apply(driverPod(name, args));
  const start = Date.now();
  const phaseOf = () =>
    run(
      k("get", "pod", name, "-o", "jsonpath={.status.phase}"),
      undefined,
      true,
    ).trim();
  for (;;) {
    await Bun.sleep(5000);
    const phase = phaseOf();
    if (phase === "Pending") failIfStuck(k, (pod) => pod === name);
    if (phase === "Succeeded" || phase === "Failed") break;
    const waited = Date.now() - start;
    if (phase === "Pending" && waited > READY_MS) {
      throw new Error(
        `pod ${name} did not start in ${READY_MS / 60_000} minutes`,
      );
    }
    if (waited > doneMs) {
      const log = Bun.spawnSync(k("logs", name)).stdout.toString();
      if (log !== "") console.log(log);
      throw new Error(
        `pod ${name} did not end in ${Math.round(doneMs / 60_000)} minutes`,
      );
    }
  }
  return run(k("logs", name), undefined, true);
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
function stopOnExit() {
  process.on("exit", stopChildren);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopChildren();
      process.exit(130);
    });
  }
}

async function step(mult: string, minutes: string, caps?: CapsMode) {
  const label = flag("label") ?? `cluster-step-${mult}x`;
  const results = join(OUT_DIR, "results", label);
  mkdirSync(results, { recursive: true });
  await scripts();
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

if (import.meta.main) await main();
