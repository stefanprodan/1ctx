// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { shutdownOnSignal } from "../../../src/server/lib/shutdown.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shutdownOnSignal", () => {
  test("logs a rejected shutdown and exits with failure", async () => {
    const logs: string[] = [];
    const exits: number[] = [];
    shutdownOnSignal("SIGTERM", {
      shutdown: async () => {
        throw new Error("close failed");
      },
      log: (message) => logs.push(message),
      exit: (code) => exits.push(code),
    });
    await settle();
    expect(logs).toEqual(["SIGTERM: shutdown failed: Error: close failed"]);
    expect(exits).toEqual([1]);
  });
});
