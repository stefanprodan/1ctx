// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  answerOf,
  type CheckAsk,
  type CheckPorts,
  check,
  reach,
} from "../../../src/server/automations/check-fetch.ts";
import type { Clock } from "../../../src/server/lib/clock.ts";
import { sha256 } from "../../../src/server/lib/ids.ts";
import { CHECK_URL } from "../../helpers/app.ts";

const ask: CheckAsk = {
  url: `${CHECK_URL}/alerts?token=q`,
  projectId: "p1",
  servers: [],
  disabled: [],
  etag: null,
  lastModified: null,
  hash: null,
  maxBytes: 1024,
};

const ports = (over: Partial<CheckPorts> = {}): CheckPorts => ({
  fetch: (async () => new Response("")) as unknown as typeof fetch,
  web: () => ({ mode: "all", domains: [] }),
  mcpServers: () => [],
  mcpKey: () => null,
  credentials: () => [],
  readKey: () => ({ ok: false, reason: "missing" }),
  ...over,
});

const answer = (body: BodyInit | null, init: ResponseInit = {}) =>
  answerOf(new Response(body, init), ask);

describe("a check's answer", () => {
  test("nothing new: a 204, a 304, an empty 200 and the same body", async () => {
    expect((await answer(null, { status: 204 })).result).toBe("204");
    expect((await answer(null, { status: 304 })).result).toBe("304");
    for (const body of [" \n\t", "[]", "{}", "null", " [ ] \n"]) {
      expect((await answer(body)).result).toBe("empty");
    }
    const body = '{"issues":[],"total":0}';
    expect(
      (await answerOf(new Response(body), { ...ask, hash: sha256(body) }))
        .result,
    ).toBe("unchanged");
  });

  test("a new 200 is text by its bytes, whatever its type", async () => {
    for (const type of ["application/atom+xml", "binary/octet-stream", null]) {
      const response = new Response("<feed>one</feed>", {
        headers: type === null ? {} : { "content-type": type, etag: '"e1"' },
      });
      if (type === null) response.headers.delete("content-type");
      const got = await answerOf(response, ask);
      expect(got).toMatchObject({
        result: "200",
        body: "<feed>one</feed>",
        hash: sha256("<feed>one</feed>"),
      });
    }
  });

  test("failures are a status or a fixed phrase", async () => {
    expect((await answer("a\0b")).result).toBe("answer is not text");
    expect((await answer(new Uint8Array([0xff, 0xfe]))).result).toBe(
      "answer is not text",
    );
    expect((await answer("x".repeat(1025))).result).toBe("answer too large");
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(800)));
        controller.enqueue(new TextEncoder().encode("x".repeat(800)));
        controller.close();
      },
    });
    expect((await answer(streamed)).result).toBe("answer too large");
    expect((await answer("down", { status: 503 })).result).toBe("HTTP 503");
    expect(
      (await answer(null, { status: 302, headers: { location: "/x" } })).result,
    ).toBe("redirected");
  });
});

describe("a check's GET", () => {
  const clock = () => {
    let now = 0;
    const sleepers: { at: number; resolve: () => void }[] = [];
    const fake = Object.assign(() => now, {
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          const sleeper = { at: now + ms, resolve };
          sleepers.push(sleeper);
          signal?.addEventListener("abort", () => {
            sleepers.splice(sleepers.indexOf(sleeper), 1);
          });
        }),
    }) as Clock;
    return {
      fake,
      sleepers,
      ring() {
        now += 10_000;
        for (const sleeper of sleepers.splice(0)) sleeper.resolve();
      },
    };
  };

  test("sends the validators, never follows a redirect and times out on the clock", async () => {
    const seen: RequestInit[] = [];
    const time = clock();
    const hung = check(
      ports({
        fetch: ((_url: string, init: RequestInit) => {
          seen.push(init);
          return new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          );
        }) as unknown as typeof fetch,
      }),
      time.fake,
      { ...ask, etag: '"e1"', lastModified: "Mon, 26 Oct 2026 06:00:00 GMT" },
      new AbortController().signal,
    );
    expect(time.sleepers).toHaveLength(1);
    time.ring();
    expect(await hung).toEqual({ result: "timed out" });
    expect(seen[0]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        "if-none-match": '"e1"',
        "if-modified-since": "Mon, 26 Oct 2026 06:00:00 GMT",
      },
    });
  });

  test("a redirect refused, a refused connection and a drain", async () => {
    const failing = (err: Error) =>
      ports({
        fetch: (async () => {
          throw err;
        }) as unknown as typeof fetch,
      });
    const redirect = Object.assign(new TypeError("UnexpectedRedirect"), {
      code: "UnexpectedRedirect",
    });
    const signal = new AbortController().signal;
    expect(await check(failing(redirect), clock().fake, ask, signal)).toEqual({
      result: "redirected",
    });
    expect(
      await check(failing(new TypeError(ask.url)), clock().fake, ask, signal),
    ).toEqual({ result: "could not connect" });
    const drain = new AbortController();
    drain.abort();
    expect(
      await check(failing(new TypeError("x")), clock().fake, ask, drain.signal),
    ).toBeNull();
  });
});

describe("what a check reaches", () => {
  const mcp = {
    mcpServers: () => [
      { id: "m1", url: `${CHECK_URL}/mcp`, keyName: "mcp-markets" },
    ],
    mcpKey: (name: string) => (name === "mcp-markets" ? "mcp-secret" : null),
  };
  const linked = {
    ...ask,
    servers: [{ serverId: "m1", read: true, write: false }],
  };

  test("an MCP server's origin carries its bearer, the web row off", () => {
    const off = ports({ ...mcp, web: () => ({ mode: "off", domains: [] }) });
    expect(reach(off, linked)).toEqual({ authorization: "Bearer mcp-secret" });
    // the task turned the server off: the web row decides
    expect(reach(off, { ...linked, disabled: ["mcp:m1"] })).toBe(
      "needs web access",
    );
    expect(reach(off, ask)).toBe("needs web access");
  });

  test("the web as curl: off, listed hosts on default ports, credentials", () => {
    expect(reach(ports(), { ...ask, disabled: ["web"] })).toBe(
      "needs web access",
    );
    const listed = ports({
      web: () => ({ mode: "listed", domains: ["check.test"] }),
    });
    expect(reach(listed, ask)).toEqual({});
    expect(reach(listed, { ...ask, url: "https://other.test/a" })).toBe(
      "host not listed",
    );
    expect(reach(listed, { ...ask, url: "https://check.test:8443/a" })).toBe(
      "host not listed",
    );
    const signed = ports({
      credentials: () => [
        {
          id: "c1",
          prefix: `${CHECK_URL}/`,
          header: "X-Api-Key",
          template: "{key}",
          keyName: "http-check",
          methods: ["GET"],
        },
      ],
      readKey: () => ({ ok: true, key: "http-secret" }),
    });
    expect(reach(signed, ask)).toEqual({ "X-Api-Key": "http-secret" });
    expect(reach(signed, { ...ask, disabled: ["credential:c1"] })).toEqual({});
    expect(reach(signed, { ...ask, url: "http://check.test/alerts" })).toEqual(
      {},
    );
  });
});
