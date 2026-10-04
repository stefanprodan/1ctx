// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kind target: the Helm chart's pod on a local kind cluster, the
// fakes beside it, the driver in a pod, nothing through a port-forward.
// Only a context named kind-* is used, and only a namespace named 1ctx-*.
//
//   bun scripts/load/kind.ts install [--tag TAG] [--cpu 4]
//   bun scripts/load/kind.ts setup [--max-mult 16]
//   bun scripts/load/kind.ts step MULT MINUTES [--label NAME] [--incident]
//   bun scripts/load/kind.ts smoke        (install, setup, step 1 5)
// every command: [--context kind-flux] [--namespace 1ctx-load]

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUT_DIR } from "./db/build.ts";
import { mcpBase, modelUrl, writeKind } from "./provision.ts";
import { FAKE } from "./shapes.ts";
import { printTable, summarize } from "./summarize.ts";

const ROOT = resolve(import.meta.dir, "../..");
const KIND = join(OUT_DIR, "kind");
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

const context = flag("context") ?? "kind-flux";
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
  const dir = join(KIND, "bundle");
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

async function install() {
  const { made } = writeKind(KIND, ns);
  console.log(`provision written to ${KIND}, ${made} new keys`);
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
        `--from-file=${join(KIND, "secrets")}`,
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
  run(
    k("rollout", "status", "deploy/fake-model", "--timeout=180s"),
    undefined,
    true,
  );
  run(
    k("rollout", "status", "deploy/fake-mcp", "--timeout=180s"),
    undefined,
    true,
  );
  const tag = flag("tag");
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
      join(KIND, "values.yaml"),
      ...(tag ? ["--set", `image.tag=${tag}`] : []),
      "--set",
      `resources.limits.cpu=${flag("cpu") ?? "4"}`,
      "--wait",
      "--timeout",
      "15m",
    ],
    undefined,
    true,
  );
  console.log(`installed onectx in ${context}/${ns}`);
}

// runs the driver in a fresh pod, waits for it and returns its log
async function driver(name: string, args: string[]): Promise<string> {
  run(k("delete", "pod", name, "--ignore-not-found"), undefined, true);
  apply(driverPod(name, args));
  for (;;) {
    await Bun.sleep(5000);
    const phase = run(
      k("get", "pod", name, "-o", "jsonpath={.status.phase}"),
      undefined,
      true,
    ).trim();
    if (phase === "Succeeded" || phase === "Failed") break;
  }
  return run(k("logs", name), undefined, true);
}

async function step(mult: string, minutes: string) {
  const label = flag("label") ?? `kind-step-${mult}x`;
  const results = join(OUT_DIR, "results", label);
  mkdirSync(results, { recursive: true });
  await scripts();
  await Bun.write(
    join(results, "meta.json"),
    `${JSON.stringify({ target: "kind", label, context, namespace: ns, mult: Number(mult), minutes: Number(minutes), at: new Date().toISOString() }, null, 2)}\n`,
  );
  // streamed, since the kubelet rotates a busy container's log mid-step
  const follow = (what: string, file: string) =>
    Bun.spawn(k("logs", "-f", what, "--since=1s"), {
      cwd: ROOT,
      stdout: Bun.file(join(results, file)),
      stderr: "ignore",
    });
  const followers = [
    follow("deploy/onectx", "server.log"),
    follow("deploy/fake-model", "model.log"),
    follow("deploy/fake-mcp", "mcp.log"),
  ];
  const top: string[] = [];
  const sampler = setInterval(() => {
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
  try {
    const args = [
      "step",
      mult,
      minutes,
      ...(argv.includes("--incident") ? ["--incident"] : []),
    ];
    await Bun.write(
      join(results, "driver.log"),
      await driver(`driver-${label}`.slice(0, 63), args),
    );
  } finally {
    clearInterval(sampler);
    for (const f of followers) f.kill();
    await Bun.write(join(results, "top.log"), `${top.join("\n")}\n`);
  }
  printTable([await summarize(results)]);
}

async function main() {
  checkTarget(context, ns);
  const contexts = run(
    ["kubectl", "config", "get-contexts", "-o", "name"],
    undefined,
    true,
  ).split("\n");
  if (!contexts.includes(context)) throw new Error(`no context ${context}`);
  const [command, a, b] = positional;
  if (command === "install") await install();
  else if (command === "setup") {
    await scripts();
    console.log(
      await driver("driver-setup", [
        "setup",
        "--max-mult",
        flag("max-mult") ?? "16",
      ]),
    );
  } else if (command === "step" && a && b) await step(a, b);
  else if (command === "smoke") {
    await install();
    console.log(
      await driver("driver-setup", [
        "setup",
        "--max-mult",
        "1",
        "--docs",
        "20",
      ]),
    );
    await step("1", "5");
  } else {
    console.error(
      "usage: kind.ts install|setup|step MULT MINUTES|smoke [--context kind-*] [--namespace 1ctx-*]",
    );
    process.exit(2);
  }
}

if (import.meta.main) await main();
