// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Image decodes run under their own process-wide bound, taken before
// an upload's process slot.

import { expect, test } from "bun:test";
import { acquireDecode } from "../../../src/server/images/decode.ts";
import { MAX_DECODES } from "../../../src/server/images/limits.ts";
import { PROCESS_SLOTS } from "../../../src/server/knowledge/limits.ts";
import {
  acquireProcess,
  withUpload,
} from "../../../src/server/knowledge/queue.ts";
import type { Clock } from "../../../src/server/lib/clock.ts";
import { ServiceUnavailable } from "../../../src/server/lib/errors.ts";

// an image upload whose ingest runs until its gate opens
function upload(
  user: string,
  req = new Request("http://localhost/"),
  clock: Clock = () => 0,
) {
  const gate = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  let started = false;
  const done = withUpload(
    clock,
    user,
    req,
    () => null,
    async () => {
      started = true;
      began.resolve();
      await gate.promise;
      return "kept";
    },
    acquireDecode,
  );
  return {
    done,
    open: () => gate.resolve(),
    began: began.promise,
    started: () => started,
  };
}

// the bounds are module state, shared by every test of the process
test.serial(
  "a decode past the bound waits outside a process slot",
  async () => {
    expect(MAX_DECODES).toBe(2);
    const uploads = [upload("a"), upload("b"), upload("c")];
    await uploads[0]!.began;
    await uploads[1]!.began;
    // the queue starts a waiter only on a release, so none is pending
    await Promise.resolve();
    expect(uploads[2]!.started()).toBe(false);
    // every slot the two running decodes leave is free for other work
    const signal = new AbortController().signal;
    const others = await Promise.all(
      Array.from({ length: PROCESS_SLOTS - MAX_DECODES }, () =>
        acquireProcess(signal),
      ),
    );
    for (const release of others) release();
    uploads[0]!.open();
    expect(await uploads[0]!.done).toBe("kept");
    await uploads[2]!.began;
    uploads[1]!.open();
    uploads[2]!.open();
    expect(await Promise.all(uploads.map((u) => u.done))).toEqual([
      "kept",
      "kept",
      "kept",
    ]);
  },
);

test.serial(
  "a waiting decode leaves the queue when its upload ends",
  async () => {
    const held = [upload("a"), upload("b")];
    await held[0]!.began;
    await held[1]!.began;
    const ends = new AbortController();
    const late = upload(
      "c",
      new Request("http://localhost/", { signal: ends.signal }),
    );
    ends.abort();
    const refused = await late.done.then(
      () => null,
      (error) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(ServiceUnavailable);
    for (const u of held) u.open();
    await Promise.all(held.map((u) => u.done));
    expect(late.started()).toBe(false);
  },
);

test.serial("a decode wait past the upload's deadline is a 503", async () => {
  const held = [upload("a"), upload("b")];
  await held[0]!.began;
  await held[1]!.began;
  // the deadline's sleep ends when the test says
  const due = Promise.withResolvers<void>();
  const clock: Clock = Object.assign(() => 0, { sleep: () => due.promise });
  const late = upload("c", undefined, clock);
  due.resolve();
  const refused = await late.done.then(
    () => null,
    (error) => error,
  );
  expect(refused).toBeInstanceOf(ServiceUnavailable);
  for (const u of held) u.open();
  await Promise.all(held.map((u) => u.done));
  expect(late.started()).toBe(false);
});
