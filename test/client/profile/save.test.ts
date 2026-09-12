// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Save behind a form's button: a problem is a reason without a call,
// a call is busy then done for a moment, a failure is its reason until
// the next edit, an edit during done wakes the button, a second submit
// while busy is ignored, and a call answering after the form is gone
// changes nothing.

import { describe, expect, test } from "bun:test";
import { Save } from "../../../src/client/views/profile/Profile.state.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Save", () => {
  test("a problem is shown without a call", async () => {
    let calls = 0;
    const save = new Save(async () => void calls++);
    await save.run("Enter a name");
    expect(save.status.value).toEqual({ error: "Enter a name" });
    expect(calls).toBe(0);
    save.touch();
    expect(save.status.value).toBe("idle");
  });

  test("busy, then done, then idle after the moment", async () => {
    const call = deferred();
    const save = new Save(() => call.promise, 5);
    const run = save.run(null);
    expect(save.status.value).toBe("busy");
    call.resolve();
    await run;
    expect(save.status.value).toBe("done");
    await new Promise((r) => setTimeout(r, 20));
    expect(save.status.value).toBe("idle");
  });

  test("a failure is its reason until the next edit", async () => {
    const save = new Save(() => Promise.reject(new Error("refused")));
    await save.run(null);
    expect(save.status.value).toEqual({ error: "refused" });
    save.touch();
    expect(save.status.value).toBe("idle");
  });

  test("an edit during done wakes the button at once", async () => {
    const save = new Save(async () => {}, 10_000);
    await save.run(null);
    expect(save.status.value).toBe("done");
    save.touch();
    expect(save.status.value).toBe("idle");
    save.dispose();
  });

  test("a second submit while busy is ignored", async () => {
    const call = deferred();
    let calls = 0;
    const save = new Save(() => {
      calls++;
      return call.promise;
    });
    const first = save.run(null);
    await save.run(null);
    save.touch();
    expect(save.status.value).toBe("busy");
    call.resolve();
    await first;
    expect(calls).toBe(1);
    save.dispose();
  });

  test("an answer after dispose changes nothing", async () => {
    const call = deferred();
    const save = new Save(() => call.promise, 5);
    const run = save.run(null);
    save.dispose();
    call.resolve();
    await run;
    await tick();
    expect(save.status.value).toBe("busy");
  });
});
