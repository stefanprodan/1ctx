// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { Flight, type Timer } from "../../../src/client/data/flight.ts";

// a clock moved by hand: pending callbacks fire in time order
function fakeTimer() {
  let now = 0;
  let ids = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timer: Timer = {
    set(fn, ms) {
      const id = ++ids;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, { at, fn }] of [...pending].sort(
      (a, b) => a[1].at - b[1].at,
    )) {
      if (at > now) continue;
      pending.delete(id);
      fn();
    }
  };
  return { timer, advance, pending: () => pending.size };
}

// a load that lands when the test says
function gated() {
  const gates: (() => void)[] = [];
  const load = () =>
    new Promise<void>((resolve) => {
      gates.push(resolve);
    });
  const land = async (i: number) => {
    gates[i]!();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { load, land, started: () => gates.length };
}

describe("one load at a time", () => {
  test("an ask with nothing out loads at once", () => {
    const { timer } = fakeTimer();
    const { load, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    expect(started()).toBe(1);
  });

  test("a burst while one is out folds into one trailing load", async () => {
    const { timer, advance } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    for (let i = 0; i < 1000; i++) flight.ask();
    expect(started()).toBe(1);
    await land(0);
    expect(started()).toBe(1);
    advance(299);
    expect(started()).toBe(1);
    advance(1);
    expect(started()).toBe(2);
    await land(1);
    advance(1000);
    expect(started()).toBe(2);
  });

  test("an ask in the pause after a load waits for its end", async () => {
    const { timer, advance } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    await land(0);
    advance(100);
    flight.ask();
    flight.ask();
    expect(started()).toBe(1);
    advance(200);
    expect(started()).toBe(2);
  });

  test("with nothing asked the pause ends quietly", async () => {
    const { timer, advance, pending } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    await land(0);
    advance(300);
    expect(pending()).toBe(0);
    flight.ask();
    expect(started()).toBe(2);
  });

  test("a cold load runs at once and answers what was asked", async () => {
    const { timer, advance } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    flight.ask();
    let cold = 0;
    const coldLoad = flight.run(() => {
      cold++;
      return load();
    });
    expect(cold).toBe(1);
    expect(started()).toBe(2);
    // the superseded warm load lands: it neither ends the cold one's
    // flight nor starts a pause
    await land(0);
    flight.ask();
    expect(started()).toBe(2);
    await land(1);
    await coldLoad;
    advance(300);
    // the ask made during the cold load trails it
    expect(started()).toBe(3);
  });

  test("after a cold load with nothing trailing, an ask loads at once", async () => {
    const { timer, pending } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    const cold = flight.run(load);
    await land(0);
    await cold;
    expect(pending()).toBe(0);
    flight.ask();
    expect(started()).toBe(2);
  });

  test("a stop drops the trailing load and the pause", async () => {
    const { timer, advance, pending } = fakeTimer();
    const { load, land, started } = gated();
    const flight = new Flight(load, timer, 300);
    flight.ask();
    flight.ask();
    await land(0);
    flight.stop();
    expect(pending()).toBe(0);
    advance(1000);
    expect(started()).toBe(1);
    flight.ask();
    expect(started()).toBe(2);
  });

  test("a load that fails still ends its flight", async () => {
    const { timer, advance } = fakeTimer();
    let n = 0;
    const flight = new Flight(
      () => {
        n++;
        return Promise.reject(new Error("down")).catch(() => {});
      },
      timer,
      300,
    );
    flight.ask();
    await Promise.resolve();
    await Promise.resolve();
    flight.ask();
    advance(300);
    expect(n).toBe(2);
  });
});
