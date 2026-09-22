// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { shutdownOnSignal } from "../../../src/server/lib/shutdown.ts";
import { collectLogs } from "../../helpers/app.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shutdownOnSignal", () => {
  test("logs a rejected shutdown and exits with failure", async () => {
    const logs = collectLogs();
    const exits: number[] = [];
    shutdownOnSignal("SIGTERM", {
      shutdown: async () => {
        throw new Error("close failed");
      },
      log: logs.logFactory("1ctx"),
      exit: (code) => exits.push(code),
    });
    await settle();
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      area: "1ctx",
      msg: "shutdown failed",
      fields: { signal: "SIGTERM", error: "close failed" },
    });
    expect(exits).toEqual([1]);
  });
});
