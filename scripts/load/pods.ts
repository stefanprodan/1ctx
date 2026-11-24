// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster target's one-shot pods: waiting for one to end, and the
// mint step that opens the driver's logins in the stopped server's
// database. kubectl comes in as a function, so a test runs a fake.

import { newLogins } from "./logins.ts";
import { failIfStuck, rolledOut } from "./rollout.ts";

export type Kubectl = (...args: string[]) => string[];

export type Kube = {
  k: Kubectl;
  sleep(ms: number): Promise<void>;
  // true once SIGINT or SIGTERM asked the run to stop
  cancelled(): boolean;
};

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export function kubectl(cmd: string[], input?: string): string {
  const p = Bun.spawnSync(cmd, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
  });
  if (p.exitCode !== 0) {
    throw new Error(
      `${cmd.slice(0, 4).join(" ")}: ${p.stderr.toString().trim()}`,
    );
  }
  return p.stdout.toString();
}

export const READY_MS = 3 * 60_000;

// the pod's last phase, Succeeded or Failed; it must start within
// READY_MS and end within doneMs, or the run fails
export async function ended(
  kube: Kube,
  name: string,
  doneMs: number,
): Promise<string> {
  const { k } = kube;
  const start = Date.now();
  for (;;) {
    if (kube.cancelled()) throw new Cancelled();
    await kube.sleep(5000);
    if (kube.cancelled()) throw new Cancelled();
    const phase = kubectl(
      k("get", "pod", name, "-o", "jsonpath={.status.phase}"),
    ).trim();
    if (phase === "Pending") failIfStuck(k, (pod) => pod === name);
    if (phase === "Succeeded" || phase === "Failed") return phase;
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
}

export const LOGINS_SECRET = "load-logins";
export const MINT_POD = "mint-logins";
// the chart's selector for release onectx
const SERVER_PODS =
  "app.kubernetes.io/name=onectx,app.kubernetes.io/instance=onectx";

// as the chart's server runs, on its volume, with the hashes alone
export function mintPod(ns: string, image: string): string {
  return `apiVersion: v1
kind: Pod
metadata: { name: ${MINT_POD}, namespace: ${ns} }
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    fsGroup: 65532
  containers:
    - name: mint
      image: ${image}
      command: ["bun", "/load/mint.js", "/data/1ctx.sqlite", "/mint/hashes.json"]
      volumeMounts:
        - { name: scripts, mountPath: /load }
        - { name: hashes, mountPath: /mint, readOnly: true }
        - { name: data, mountPath: /data }
  volumes:
    - { name: scripts, configMap: { name: load-scripts } }
    - { name: hashes, configMap: { name: ${MINT_POD} } }
    - { name: data, persistentVolumeClaim: { claimName: onectx } }
`;
}

// A login per user, opened in the stopped server's database. The mint
// pod gets the hashes, the driver's Secret the tokens, both on kubectl's
// stdin, never in a file. Whatever happens the mint pod is deleted and
// gone before the server scales back, so two never hold the volume.
export async function mint(
  kube: Kube,
  users: string[],
  ns: string,
  image: string,
) {
  const { k } = kube;
  const { tokens, hashes } = newLogins(users);
  const apply = (yaml: string) => kubectl(k("apply", "-f", "-"), yaml);
  const create = (input: string, ...args: string[]) =>
    apply(
      kubectl(k("create", ...args, "--dry-run=client", "-o", "yaml"), input),
    );
  create(
    JSON.stringify(hashes),
    "configmap",
    MINT_POD,
    "--from-file=hashes.json=/dev/stdin",
  );
  create(
    JSON.stringify(tokens),
    "secret",
    "generic",
    LOGINS_SECRET,
    "--from-file=logins.json=/dev/stdin",
  );
  const deleteMint = () =>
    kubectl(k("delete", "pod", MINT_POD, "--ignore-not-found", "--wait=true"));
  let failure: unknown = null;
  try {
    deleteMint();
    kubectl(k("scale", "deploy/onectx", "--replicas=0"));
    const gone = Bun.spawnSync(
      k("wait", "--for=delete", "pod", "-l", SERVER_PODS, "--timeout=5m"),
    );
    const err = gone.stderr.toString();
    // older kubectl calls a selector that matches nothing an error
    if (gone.exitCode !== 0 && !err.includes("no matching resources")) {
      throw new Error(`waiting for the server to stop: ${err.trim()}`);
    }
    apply(mintPod(ns, image));
    const phase = await ended(kube, MINT_POD, READY_MS + 60_000);
    const log = kubectl(k("logs", MINT_POD)).trim();
    if (phase !== "Succeeded") throw new Error(`minting logins: ${log}`);
    console.log(log);
  } catch (e) {
    failure = e;
  }
  await restore(kube, deleteMint, failure);
  if (failure !== null) throw failure;
}

// The server back on every ending: the mint pod gone (one retry), one
// replica, the rollout waited on. A pod that will not go leaves the
// server down rather than two pods on one volume.
async function restore(kube: Kube, deleteMint: () => void, failure: unknown) {
  const { k } = kube;
  try {
    try {
      deleteMint();
    } catch {
      deleteMint();
    }
    kubectl(k("scale", "deploy/onectx", "--replicas=1"));
    await rolledOut(k, "onectx");
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const after =
      failure === null
        ? ""
        : ` (after: ${failure instanceof Error ? failure.message : String(failure)})`;
    throw new RecoveryFailed(`the server was not restored: ${why}${after}`);
  }
}

// cleanup that failed: never hidden behind a cancel's exit code
export class RecoveryFailed extends Error {}
