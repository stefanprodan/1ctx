// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { jsonBody, readBody, readBytes } from "../../../src/server/lib/body.ts";

const binary = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0xc3, 0x28, 0xfe,
]);

function request(body?: BodyInit, headers?: HeadersInit): Request {
  return new Request("http://1ctx.test/api/body", {
    method: "POST",
    body,
    headers,
  });
}

describe("readBytes", () => {
  test("keeps binary bytes exactly at the cap, including chunk offsets", async () => {
    const req = request(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(binary.subarray(0, 5));
          controller.enqueue(binary.subarray(5));
          controller.close();
        },
      }),
    );
    const bytes = await readBytes(req, binary.length);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(binary);
    expect(req.body?.locked).toBe(false);
  });

  test("an absent or empty body is empty bytes", async () => {
    expect(await readBytes(request(), 0)).toEqual(new Uint8Array());
    expect(await readBytes(request(new Uint8Array()), 0)).toEqual(
      new Uint8Array(),
    );
  });

  test("refuses a declared length before reading the stream", async () => {
    let pulled = false;
    const req = request(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { "content-length": "11" },
    );
    await expect(readBytes(req, 10)).rejects.toMatchObject({
      status: 413,
      message: "body too large",
    });
    expect(pulled).toBe(false);
    expect(req.body?.locked).toBe(false);
  });

  for (const declared of [undefined, "1"]) {
    test(`refuses stream overflow with declared length ${declared}`, async () => {
      let pulled = 0;
      let cancelled = false;
      const req = request(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(4));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        declared ? { "content-length": declared } : undefined,
      );
      await expect(readBytes(req, 7)).rejects.toMatchObject({
        status: 413,
        message: "body too large",
      });
      expect(pulled).toBe(2);
      expect(cancelled).toBe(true);
      expect(req.body?.locked).toBe(false);
    });
  }

  test("abort cancels a stalled read and waits for cancellation to settle", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    const cleanup = Promise.withResolvers<void>();
    const stop = new AbortController();
    const reason = new Error("deadline");
    const req = request(
      new ReadableStream<Uint8Array>({
        pull() {
          started.resolve();
          return new Promise(() => {});
        },
        cancel(why) {
          cancelled.resolve(why);
          return cleanup.promise;
        },
      }),
    );
    let settled = false;
    const result = readBytes(req, 10, stop.signal).then(
      (bytes) => {
        settled = true;
        return bytes;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await started.promise;
      stop.abort(reason);
      expect(await cancelled.promise).toBe(reason);
      await Bun.sleep(0);
      expect(settled).toBe(false);
      expect(req.body?.locked).toBe(true);
    } finally {
      cleanup.resolve();
    }
    expect(await result).toBe(reason);
    expect(req.body?.locked).toBe(false);
  });

  test("an already aborted signal cancels without reading", async () => {
    let cancelled = false;
    let pulled = false;
    const req = request(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(readBytes(req, 10, AbortSignal.abort())).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBe(false);
    expect(req.body?.locked).toBe(false);
  });

  test("a cancellation failure does not replace the abort reason", async () => {
    const reason = new Error("deadline");
    const req = request(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
    );
    await expect(readBytes(req, 10, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(req.body?.locked).toBe(false);
  });

  test("a stream failure propagates and releases the reader", async () => {
    const reason = new Error("connection lost");
    const req = request(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(reason);
        },
      }),
    );
    await expect(readBytes(req, 10)).rejects.toBe(reason);
    expect(req.body?.locked).toBe(false);
  });
});

describe("readBody and jsonBody", () => {
  test("JSON and UTF-8 split across chunks keep their behavior", async () => {
    const text = '{"name":"caf\u00e9","count":2}';
    const bytes = new TextEncoder().encode(text);
    const req = request(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) {
            controller.enqueue(new Uint8Array([byte]));
          }
          controller.close();
        },
      }),
    );
    expect(await readBody(req, bytes.length)).toBe(text);
    expect(await jsonBody(request(text), bytes.length)).toEqual({
      name: "caf\u00e9",
      count: 2,
    });
  });

  test("decoding, empty bodies and invalid JSON keep their words", async () => {
    expect(await readBody(request(new Uint8Array([0xff])))).toBe("\ufffd");
    expect(await readBody(request())).toBe("");
    for (const body of [undefined, "not JSON"]) {
      await expect(jsonBody(request(body))).rejects.toMatchObject({
        status: 400,
        message: "body must be JSON",
      });
    }
    await expect(jsonBody(request('{"ok":true}'), 2)).rejects.toMatchObject({
      status: 413,
      message: "body too large",
    });
  });
});
