// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Waits on the kind target's pods that fail fast: a pod that cannot
// start ends the wait at once with its last log, instead of sitting out
// a timeout in a crash or pull back-off.

type Kubectl = (...args: string[]) => string[];

const STUCK = [
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
];

// a fresh load database migrates in seconds, so a rollout that takes
// minutes is broken, not slow
const ROLLOUT_MS = 3 * 60_000;

interface Pods {
  items: {
    metadata: { name: string };
    status: {
      containerStatuses?: {
        state: { waiting?: { reason?: string; message?: string } };
      }[];
    };
  }[];
}

function out(cmd: string[]): string {
  const p = Bun.spawnSync(cmd);
  if (p.exitCode !== 0)
    throw new Error(`${cmd.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

// throws when a matching pod waits for a reason it never leaves alone
export function failIfStuck(k: Kubectl, match: (pod: string) => boolean) {
  const pods = JSON.parse(out(k("get", "pods", "-o", "json"))) as Pods;
  for (const pod of pods.items) {
    if (!match(pod.metadata.name)) continue;
    for (const c of pod.status.containerStatuses ?? []) {
      const waiting = c.state.waiting;
      if (!waiting?.reason || !STUCK.includes(waiting.reason)) continue;
      const log = Bun.spawnSync(
        k("logs", pod.metadata.name, "--previous", "--tail=30"),
      ).stdout.toString();
      if (log !== "") console.log(log);
      throw new Error(
        `pod ${pod.metadata.name} is ${waiting.reason}: ${waiting.message ?? ""}`,
      );
    }
  }
}

// every replica of the deployment's latest spec available
export async function rolledOut(k: Kubectl, deploy: string) {
  const start = Date.now();
  for (;;) {
    const [gen, seen, want, updated, available, unavailable] = out(
      k(
        "get",
        "deploy",
        deploy,
        "-o",
        "jsonpath={.metadata.generation} {.status.observedGeneration} {.spec.replicas} {.status.updatedReplicas} {.status.availableReplicas} {.status.unavailableReplicas}",
      ),
    ).split(" ");
    if (gen === seen && updated === want && available === want && !unavailable)
      return;
    failIfStuck(k, (pod) => pod.startsWith(`${deploy}-`));
    if (Date.now() - start > ROLLOUT_MS) {
      throw new Error(`${deploy}: not ready in ${ROLLOUT_MS / 60_000} minutes`);
    }
    await Bun.sleep(2000);
  }
}
