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

// a clock whose sleep the test ends
function held() {
  let deadline = () => {};
  const clock = Object.assign(() => 0, {
    sleep: () =>
      new Promise<void>((resolve) => {
        deadline = resolve;
      }),
  }) satisfies Clock;
  return { clock, deadline: () => deadline() };
}

const registryOf = (sends: ActiveSend[]) =>
  ({ close: () => {}, values: () => sends }) as unknown as Registry;

const never = () => new Promise<void>(() => {});

test("an ask that never lets go meets the deadline with no sends", async () => {
  const { clock, deadline } = held();
  const result = shutdownRunner(registryOf([]), clock, () => {}, 5_000, never);
  deadline();
  expect(await result).toEqual({ ended: 0, timedOut: true });
});

test("a drained send and a held ask take the deadline path", async () => {
  const { clock, deadline } = held();
  const send = { drained: Promise.resolve() } as ActiveSend;
  const result = shutdownRunner(
    registryOf([send]),
    clock,
    () => {},
    5_000,
    never,
  );
  deadline();
  expect(await result).toEqual({ ended: 1, timedOut: true });
});

test("no sends and settled asks end at once", async () => {
  const { clock } = held();
  expect(
    await shutdownRunner(
      registryOf([]),
      clock,
      () => {},
      5_000,
      async () => {},
    ),
  ).toEqual({ ended: 0, timedOut: false });
});
