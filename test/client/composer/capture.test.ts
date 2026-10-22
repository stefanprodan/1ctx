// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The capture's start over fake browser parts: a cancel lets go at once
// whatever step is pending, a grant after it has its tracks stopped, a
// failed resume ends the start without waiting on the prompt, a context
// or a track that went during the start is a failure, never a silent
// recording, a context suspended once it runs is the recording's end, and
// a failed resume is never left unhandled.

import { describe, expect, test } from "bun:test";
import {
  type CaptureContext,
  type CaptureParts,
  startCapture,
} from "../../../src/client/composer/capture.ts";
import { captureLine } from "../../../src/client/composer/dictation.ts";
import { deferred, rejection, settle } from "../../helpers/async.ts";

type Held = ReturnType<typeof deferred<void>>;

function fakes(over: { resume?: Held; state?: string } = {}) {
  const grant = deferred<{ getTracks(): typeof tracks }>();
  const module = deferred<void>();
  // settles once the start asks for the module, so a test knows the
  // grant and the resume landed
  const asked = deferred<void>();
  const resume = over.resume ?? deferred<void>();
  if (over.resume === undefined) resume.resolve();
  const stopped: string[] = [];
  const listeners: (() => void)[] = [];
  const mic = {
    readyState: "live",
    stop: () => stopped.push("mic"),
    addEventListener: (_: "ended", fn: () => void) => listeners.push(fn),
  };
  const tracks = [mic];
  let state = over.state ?? "running";
  let closes = 0;
  let wired = 0;
  const context: CaptureContext = {
    get state() {
      return state;
    },
    sampleRate: 48_000,
    onstatechange: null,
    resume: () => resume.promise,
    close: async () => {
      closes++;
      state = "closed";
    },
    addModule: () => {
      asked.resolve();
      return module.promise;
    },
    wire: () => {
      wired++;
    },
  };
  const revoked: string[] = [];
  const parts: CaptureParts = {
    context: () => context,
    getUserMedia: () => grant.promise as never,
    moduleUrl: () => ({ url: "blob:tap", revoke: () => revoked.push("x") }),
  };
  return {
    parts,
    grant: () => grant.resolve({ getTracks: () => tracks }),
    // the grant's own promise: awaited after it, the start's handlers ran
    granted: () => grant.promise.then(() => {}),
    deny: () =>
      grant.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
    asked: () => asked.promise,
    load: () => module.resolve(),
    // the browser moves the context, and says so
    become: (next: string) => {
      state = next;
      context.onstatechange?.();
    },
    unplug: () => {
      mic.readyState = "ended";
      for (const fn of listeners) fn();
    },
    stopped,
    revoked,
    closes: () => closes,
    wired: () => wired,
  };
}

const none = () => {};

describe("the capture's start", () => {
  test("runs through the prompt and the module, then reports the rate", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    f.grant();
    f.load();
    expect(await pending.ready).toEqual({ rate: 48_000 });
    expect(f.wired()).toBe(1);
    expect(f.revoked).toHaveLength(1);
    pending.cancel();
    expect(f.stopped).toEqual(["mic"]);
    expect(f.closes()).toBe(1);
  });

  test("a cancel during the prompt closes the context at once, a late grant stops", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    pending.cancel();
    expect(f.closes()).toBe(1);
    const err = await rejection(pending.ready);
    expect(err.name).toBe("AbortError");
    f.grant();
    await f.granted();
    expect(f.stopped).toEqual(["mic"]);
    expect(f.wired()).toBe(0);
  });

  test("a cancel just after the grant lands stops its tracks", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    f.grant();
    // the grant's handlers ran; the start has not yet taken its answer
    await f.granted();
    pending.cancel();
    expect(f.stopped).toEqual(["mic"]);
    await rejection(pending.ready);
    expect(f.wired()).toBe(0);
  });

  test.serial(
    "a prompt that throws leaves no failed resume unhandled",
    async () => {
      const resume = deferred<void>();
      const f = fakes({ resume });
      const unhandled: unknown[] = [];
      const seen = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", seen);
      try {
        const pending = startCapture(none, none, {
          ...f.parts,
          getUserMedia: () => {
            throw Object.assign(new Error("no"), { name: "TypeError" });
          },
        });
        resume.reject(new Error("not allowed to start"));
        await rejection(pending.ready);
        // one macrotask, where the runtime reports what nobody handled
        await settle();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", seen);
      }
    },
  );

  test("a cancel while the module loads stops the tracks and builds nothing", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    f.grant();
    await f.asked();
    pending.cancel();
    expect(f.stopped).toEqual(["mic"]);
    expect(f.closes()).toBe(1);
    await rejection(pending.ready);
    f.load();
    expect(f.wired()).toBe(0);
  });

  test("a refused prompt is the browser's refusal, the context closed", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    f.deny();
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: blocked in the browser");
    expect(f.closes()).toBe(1);
  });

  test("a resume that fails after the grant is blocked, the tracks stopped", async () => {
    const resume = deferred<void>();
    const f = fakes({ resume });
    const pending = startCapture(none, none, f.parts);
    f.grant();
    await f.granted();
    resume.reject(new Error("not allowed to start"));
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: blocked in the browser");
    expect(f.stopped).toEqual(["mic"]);
    expect(f.wired()).toBe(0);
  });

  test("a resume that fails during the prompt ends the start without it", async () => {
    const resume = deferred<void>();
    const f = fakes({ resume });
    const pending = startCapture(none, none, f.parts);
    resume.reject(new Error("not allowed to start"));
    // the prompt is still up
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: blocked in the browser");
    expect(f.closes()).toBe(1);
    f.grant();
    await f.granted();
    expect(f.stopped).toEqual(["mic"]);
  });

  test("a context still suspended after its resume never records", async () => {
    const f = fakes({ state: "suspended" });
    const pending = startCapture(none, none, f.parts);
    f.grant();
    f.load();
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: blocked in the browser");
    expect(f.wired()).toBe(0);
  });

  test("a context suspended while the module loads never records", async () => {
    const f = fakes();
    const pending = startCapture(none, none, f.parts);
    f.grant();
    await f.asked();
    f.become("suspended");
    f.load();
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: blocked in the browser");
    expect(f.wired()).toBe(0);
  });

  test("a microphone unplugged while the module loads is its end", async () => {
    const f = fakes();
    let ends = 0;
    const pending = startCapture(
      none,
      () => {
        ends++;
      },
      f.parts,
    );
    f.grant();
    await f.asked();
    f.unplug();
    expect(ends).toBe(1);
    f.load();
    const err = await rejection(pending.ready);
    expect(captureLine(err)).toBe("Dictation: no microphone");
    expect(f.wired()).toBe(0);
  });

  test("a context suspended once it runs ends the recording", async () => {
    const f = fakes();
    let ends = 0;
    const pending = startCapture(
      none,
      () => {
        ends++;
      },
      f.parts,
    );
    f.grant();
    f.load();
    await pending.ready;
    f.become("suspended");
    expect(ends).toBe(1);
    // a cancel of ours is never an end
    pending.cancel();
    f.become("closed");
    expect(ends).toBe(1);
  });
});
