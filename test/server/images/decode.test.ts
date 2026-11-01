// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Image decodes run under their own process-wide bound.

import { expect, test } from "bun:test";
import { decoding } from "../../../src/server/images/decode.ts";
import { MAX_DECODES } from "../../../src/server/images/limits.ts";

// a decode that runs until its gate opens
function gated() {
  const gate = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  let started = false;
  return {
    work: async () => {
      started = true;
      began.resolve();
      await gate.promise;
      return "kept";
    },
    open: () => gate.resolve(),
    began: began.promise,
    started: () => started,
  };
}

// the bound is module state, shared by every test of the process
test.serial("a decode past the bound waits until one finishes", async () => {
  expect(MAX_DECODES).toBe(2);
  const signal = new AbortController().signal;
  const decodes = [gated(), gated(), gated()];
  const results = decodes.map((d) => decoding(signal, d.work));
  await decodes[0]!.began;
  await decodes[1]!.began;
  // the queue starts a waiter only on a release, so none is pending
  await Promise.resolve();
  expect(decodes[2]!.started()).toBe(false);
  decodes[0]!.open();
  expect(await results[0]).toBe("kept");
  await decodes[2]!.began;
  decodes[1]!.open();
  decodes[2]!.open();
  expect(await Promise.all(results)).toEqual(["kept", "kept", "kept"]);
});

test.serial(
  "a waiting decode leaves the queue when its upload ends",
  async () => {
    const signal = new AbortController().signal;
    const held = [gated(), gated()];
    const running = held.map((d) => decoding(signal, d.work));
    await held[0]!.began;
    await held[1]!.began;
    const ends = new AbortController();
    const late = gated();
    const waiting = decoding(ends.signal, late.work);
    const busy = new Error("busy");
    ends.abort(busy);
    expect(
      await waiting.then(
        () => null,
        (error) => error,
      ),
    ).toBe(busy);
    held[0]!.open();
    held[1]!.open();
    await Promise.all(running);
    expect(late.started()).toBe(false);
  },
);
