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
    shutdownOnSignal({
      shutdown: async () => {
        throw new Error("close failed");
      },
      log: logs.logFactory("1ctx"),
      exit: (code) => exits.push(code),
    })("SIGTERM");
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

  test("the first signal drains, the second ends the drain, a third does nothing", async () => {
    const logs = collectLogs();
    const seen: string[] = [];
    let cut = false;
    const onSignal = shutdownOnSignal({
      shutdown: async (signal, ended) => {
        seen.push(signal);
        await ended;
        cut = true;
      },
      log: logs.logFactory("1ctx"),
      exit: () => {},
    });
    onSignal("SIGTERM");
    await settle();
    expect(seen).toEqual(["SIGTERM"]);
    expect(cut).toBe(false);
    onSignal("SIGINT");
    await settle();
    expect(cut).toBe(true);
    onSignal("SIGTERM");
    await settle();
    expect(seen).toEqual(["SIGTERM"]);
    expect(logs.events).toEqual([]);
  });
});
