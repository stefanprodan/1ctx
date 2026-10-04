// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { failIfStuck, rolledOut } from "../../../scripts/load/rollout.ts";

// a kubectl that prints canned answers: pods as JSON, the deployment's
// status as its jsonpath line, logs as nothing
function fake(pods: unknown, status = "2 2 1 1 1 ") {
  return (...args: string[]) => {
    if (args[0] === "get" && args[1] === "pods")
      return ["printf", "%s", JSON.stringify(pods)];
    if (args[0] === "get" && args[1] === "deploy")
      return ["printf", "%s", status];
    return ["true"];
  };
}

const pod = (name: string, reason?: string) => ({
  metadata: { name },
  status: {
    containerStatuses: [
      { state: reason ? { waiting: { reason, message: "m" } } : {} },
    ],
  },
});

describe("rollout", () => {
  test("a pod in a back-off fails at once", () => {
    const k = fake({ items: [pod("onectx-abc", "CrashLoopBackOff")] });
    expect(() => failIfStuck(k, (p) => p.startsWith("onectx-"))).toThrow(
      "CrashLoopBackOff",
    );
  });

  test("a starting pod and other pods pass", () => {
    const k = fake({
      items: [
        pod("onectx-abc", "ContainerCreating"),
        pod("fake-mcp-x", "ImagePullBackOff"),
      ],
    });
    expect(() => failIfStuck(k, (p) => p.startsWith("onectx-"))).not.toThrow();
  });

  test("a rolled out deployment returns", async () => {
    await rolledOut(fake({ items: [] }), "onectx");
  });

  test("an old pod still terminating is counted", () => {
    const old = {
      ...pod("onectx-old"),
      metadata: { name: "onectx-old", deletionTimestamp: "t" },
    };
    const k = fake({ items: [old, pod("onectx-new")] });
    expect(failIfStuck(k, (p) => p.startsWith("onectx-"))).toBe(1);
  });

  test("a deployment whose pod is stuck throws", async () => {
    const k = fake(
      { items: [pod("onectx-abc", "ImagePullBackOff")] },
      "3 3 1 1  1",
    );
    await expect(rolledOut(k, "onectx")).rejects.toThrow("ImagePullBackOff");
  });
});
