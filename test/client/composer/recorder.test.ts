// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's recorder over a fake capture: it is busy from the tap,
// so a send waits; a clip under half a second is never sent; a longer
// one is, on Stop or when the device goes; leaving lets the start go; a
// start that throws in the tap leaves it idle.

import { describe, expect, test } from "bun:test";
import type { Capture, Pending } from "../../../src/client/composer/capture.ts";
import { MIN_SAMPLES } from "../../../src/client/composer/dictation.ts";
import { Recorder } from "../../../src/client/composer/recorder.ts";
import { deferred, settle } from "../../helpers/async.ts";

// a capture the test holds: the start's answer, the chunks and the end
function fake() {
  const ready = deferred<Capture>();
  let chunk: (frames: Float32Array) => void = () => {};
  let end: () => void = () => {};
  let cancels = 0;
  const start = (onChunk: typeof chunk, onEnd: typeof end): Pending => {
    chunk = onChunk;
    end = onEnd;
    ready.promise.catch(() => {});
    return {
      ready: ready.promise,
      cancel: () => {
        cancels++;
      },
    };
  };
  const sent: { key: string; samples: number }[] = [];
  const send = async (
    key: string,
    _tap: unknown,
    chunks: readonly Int16Array[],
  ) => {
    sent.push({ key, samples: chunks.reduce((n, c) => n + c.length, 0) });
  };
  const rec = new Recorder(start, send);
  return {
    rec,
    sent,
    cancels: () => cancels,
    // the device's rate is 16 kHz here, so frames are samples
    up: async () => {
      ready.resolve({ rate: 16_000 });
      await settle();
    },
    refuse: async (name: string) => {
      ready.reject(Object.assign(new Error(name), { name }));
      await settle();
    },
    feed: (samples: number) => chunk(new Float32Array(samples).fill(0.1)),
    end: () => end(),
  };
}

const tap = { text: "", cursor: 0 };
const KEY = "draft:u1:chat:s1";

describe("the recorder", () => {
  test("busy from the tap, while the prompt is up, until it is dropped", async () => {
    const f = fake();
    expect(f.rec.busy()).toBe(false);
    f.rec.start(KEY, tap, () => {});
    expect(f.rec.busy()).toBe(true);
    expect(f.rec.phase.value).toBe("starting");
    f.rec.drop();
    expect(f.cancels()).toBe(1);
    expect(f.rec.busy()).toBe(false);
    // a grant after the drop records nothing
    await f.up();
    expect(f.rec.phase.value).toBe("idle");
  });

  test("a clip under half a second is never sent", async () => {
    const f = fake();
    f.rec.start(KEY, tap, () => {});
    await f.up();
    expect(f.rec.phase.value).toBe("recording");
    f.feed(MIN_SAMPLES - 1);
    f.rec.stop();
    await settle();
    expect(f.sent).toEqual([]);
    expect(f.cancels()).toBe(1);
    expect(f.rec.busy()).toBe(false);
  });

  test("half a second and more is sent on Stop", async () => {
    const f = fake();
    f.rec.start(KEY, tap, () => {});
    await f.up();
    f.feed(MIN_SAMPLES);
    expect(f.rec.levels.value).toHaveLength(1);
    f.rec.stop();
    await settle();
    expect(f.sent).toEqual([{ key: KEY, samples: MIN_SAMPLES }]);
  });

  test("the device going away is a Stop, or a drop before the graph is up", async () => {
    const f = fake();
    f.rec.start(KEY, tap, () => {});
    await f.up();
    f.feed(MIN_SAMPLES * 2);
    f.end();
    await settle();
    expect(f.sent).toEqual([{ key: KEY, samples: MIN_SAMPLES * 2 }]);
    const g = fake();
    g.rec.start(KEY, tap, () => {});
    g.end();
    expect(g.rec.busy()).toBe(false);
    expect(g.cancels()).toBe(1);
  });

  test("a refused microphone is its line, the recorder idle", async () => {
    const f = fake();
    let line = "";
    f.rec.start(KEY, tap, (l) => {
      line = l;
    });
    await f.refuse("NotAllowedError");
    expect(line).toBe("Dictation: blocked in the browser");
    expect(f.rec.busy()).toBe(false);
  });

  test("a browser that throws in the tap is its line, the recorder idle", () => {
    const rec = new Recorder(() => {
      throw Object.assign(new Error("no AudioContext"), { name: "TypeError" });
    });
    let line = "";
    rec.start(KEY, tap, (l) => {
      line = l;
    });
    expect(line).toBe("Dictation: no microphone");
    expect(rec.busy()).toBe(false);
    expect(rec.phase.value).toBe("idle");
  });
});
