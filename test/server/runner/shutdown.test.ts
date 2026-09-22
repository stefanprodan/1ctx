// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type { Clock } from "../../../src/server/lib/clock.ts";
import type { Registry } from "../../../src/server/runner/index.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { shutdownRunner } from "../../../src/server/runner/shutdown.ts";

test("reports when the drain deadline wins", async () => {
  let deadline = () => {};
  const clock = Object.assign(() => 0, {
    sleep: () =>
      new Promise<void>((resolve) => {
        deadline = resolve;
      }),
  }) satisfies Clock;
  const send = {
    drained: new Promise<void>(() => {}),
  } as ActiveSend;
  let closed = false;
  const registry = {
    close: () => {
      closed = true;
    },
    values: () => [send],
  } as Registry;
  const ended: ActiveSend[] = [];

  const result = shutdownRunner(
    registry,
    clock,
    (active) => ended.push(active),
    5_000,
  );
  deadline();

  expect(await result).toEqual({ ended: 1, timedOut: true });
  expect(closed).toBeTrue();
  expect(ended).toEqual([send]);
});
