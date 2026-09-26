// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Save behind a form's button: a problem is a reason without a call,
// a call is busy then done for a moment, a failure is its reason until
// the next edit, an edit during done wakes the button, a second submit
// while busy is ignored, and a call answering after the form is gone
// changes nothing. A refusal naming a field is that field's and never
// the notice; another action of the form holds every button and its
// refusal is the notice, naming the action.

import { describe, expect, jest, test } from "bun:test";
import { sentence } from "../../../src/client/lib/format.ts";
import { at, noticeOf, Save } from "../../../src/client/lib/save.ts";

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

  // serial: fake timers are the process's, and the other tests wait on
  // real ones
  test.serial("busy, then done, then idle after the moment", async () => {
    jest.useFakeTimers();
    try {
      const call = deferred();
      const save = new Save(() => call.promise, 5);
      const run = save.run(null);
      expect(save.status.value).toBe("busy");
      call.resolve();
      await run;
      expect(save.status.value).toBe("done");
      jest.advanceTimersByTime(5);
      expect(save.status.value).toBe("idle");
    } finally {
      jest.useRealTimers();
    }
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

  test("a check pinned to a field is that field's, not the notice", async () => {
    const save = new Save(async () => {});
    await save.run(at("email", "Not an email address"));
    expect(save.fieldError("email")).toBe("Not an email address.");
    expect(save.fieldError("username")).toBeNull();
    expect(save.notice()).toBeNull();
    save.touch();
    expect(save.fieldError("email")).toBeNull();
  });

  test("a server refusal lands on the field its words name", async () => {
    const save = new Save(
      () => Promise.reject(new Error("username is taken")),
      5,
      (message) => (message.startsWith("username") ? "username" : undefined),
    );
    await save.run(null);
    expect(save.fieldError("username")).toBe("Username is taken.");
    expect(save.notice()).toBeNull();
  });

  test("a refusal naming no field is the notice", async () => {
    const save = new Save(
      () => Promise.reject(new Error("project has a running chat")),
      5,
      () => undefined,
    );
    await save.run(null);
    expect(save.notice()).toEqual({ error: "project has a running chat" });
  });

  test("another action holds every button and names itself when refused", async () => {
    const call = deferred();
    let saves = 0;
    const save = new Save(async () => void saves++);
    const acting = save.act("delete", () => call.promise);
    expect(save.busy).toBe(true);
    expect(save.pending.value).toBe("delete");
    await save.run(null);
    expect(await save.act("disable", async () => {})).toBe(false);
    expect(saves).toBe(0);
    call.reject(new Error("an agent uses local"));
    expect(await acting).toBe(false);
    expect(save.busy).toBe(false);
    const notice = save.notice();
    expect(notice).toEqual({
      error: "an agent uses local",
      action: "delete",
    });
    expect(noticeOf(notice!)).toBe("Could not delete. An agent uses local.");
    expect(await save.act("delete", async () => {})).toBe(true);
    expect(save.notice()).toBeNull();
    expect(save.status.value).toBe("idle");
  });

  test("the server's fragments read as sentences", () => {
    expect(sentence("email is taken")).toBe("Email is taken.");
    expect(sentence("Too many attempts. Wait a minute")).toBe(
      "Too many attempts. Wait a minute.",
    );
    expect(sentence("Done.")).toBe("Done.");
    expect(noticeOf({ error: "name is taken" })).toBe("Name is taken.");
  });
});
