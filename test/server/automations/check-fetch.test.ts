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
    // a redirect with nowhere to go is its status
    expect((await answer(null, { status: 302 })).result).toBe("HTTP 302");
  });
});

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

describe("a check's GET", () => {
  test("sends the validators and times out on the clock", async () => {
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
      redirect: "manual",
      headers: {
        "if-none-match": '"e1"',
        "if-modified-since": "Mon, 26 Oct 2026 06:00:00 GMT",
      },
    });
  });

  test("a refused connection and a drain", async () => {
    const failing = (err: Error) =>
      ports({
        fetch: (async () => {
          throw err;
        }) as unknown as typeof fetch,
      });
    const signal = new AbortController().signal;
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

const credential = {
  id: "c1",
  prefix: `${CHECK_URL}/`,
  header: "X-Api-Key",
  template: "{key}",
  keyName: "http-check",
  methods: ["GET" as const],
};

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
    expect(reach(off, linked)).toEqual({
      headers: { authorization: "Bearer mcp-secret" },
      scope: { origin: CHECK_URL },
      key: "mcp-secret",
    });
    // the task turned the server off: the web row decides
    expect(reach(off, { ...linked, disabled: ["mcp:m1"] })).toBe(
      "web access is off",
    );
    expect(reach(off, ask)).toBe("web access is off");
  });

  test("the web as curl: off, listed hosts on default ports, credentials", () => {
    expect(reach(ports(), { ...ask, disabled: ["web"] })).toBe(
      "web access is off",
    );
    const listed = ports({
      web: () => ({ mode: "listed", domains: ["check.test"] }),
    });
    expect(reach(listed, ask)).toEqual({ headers: {}, scope: null, key: null });
    expect(reach(listed, { ...ask, url: "https://other.test/a" })).toBe(
      "host is not in Web access",
    );
    expect(reach(listed, { ...ask, url: "https://check.test:8443/a" })).toBe(
      "host is not in Web access",
    );
    const signed = ports({
      credentials: () => [credential],
      readKey: () => ({ ok: true, key: "http-secret" }),
    });
    expect(reach(signed, ask)).toEqual({
      headers: { "X-Api-Key": "http-secret" },
      scope: { prefix: `${CHECK_URL}/` },
      key: "http-secret",
    });
    // curl's credential fetch reaches its prefix, listed or not
    const unlisted = ports({
      web: () => ({ mode: "listed", domains: [] }),
      credentials: () => [credential],
      readKey: () => ({ ok: true, key: "http-secret" }),
    });
    expect(reach(unlisted, ask)).toMatchObject({ key: "http-secret" });
    expect(reach(unlisted, { ...ask, url: "https://other.test/a" })).toBe(
      "host is not in Web access",
    );
    // as curl refuses the prefix by name
    expect(reach(signed, { ...ask, disabled: ["credential:c1"] })).toBe(
      "its credential is turned off",
    );
    expect(reach(ports({ credentials: () => [credential] }), ask)).toBe(
      "its credential has no key",
    );
    expect(reach(signed, { ...ask, url: "http://check.test/alerts" })).toEqual({
      headers: {},
      scope: null,
      key: null,
    });
  });
});

describe("a check's redirects", () => {
  // each URL's answer; a request to another is a refused connection
  const site = (answers: Record<string, () => Response>) => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: { ...(init.headers as Record<string, string>) },
      });
      const answer = answers[url];
      if (answer === undefined) throw new TypeError("unable to connect");
      return answer();
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetch: fetcher };
  };
  const moved = (status: number, location: string) => () =>
    new Response(null, { status, headers: { location } });
  const signal = new AbortController().signal;
  const listed = {
    web: () => ({
      mode: "listed" as const,
      domains: ["check.test", "cdn.test"],
    }),
  };

  test("a 301 then a 302 to a listed host is followed and its answer decides", async () => {
    const { seen, fetch } = site({
      [ask.url]: moved(301, "/v2/alerts"),
      [`${CHECK_URL}/v2/alerts`]: moved(302, "https://cdn.test/alerts.json"),
      "https://cdn.test/alerts.json": () => new Response('{"alerts":[1]}'),
    });
    const got = await check(
      ports({ ...listed, fetch }),
      clock().fake,
      { ...ask, etag: '"e1"' },
      signal,
    );
    expect(got).toMatchObject({ result: "200", body: '{"alerts":[1]}' });
    expect(seen.map((call) => call.url)).toEqual([
      ask.url,
      `${CHECK_URL}/v2/alerts`,
      "https://cdn.test/alerts.json",
    ]);
    // the validators belong to the check URL's answer
    expect(seen.every((call) => call.headers["if-none-match"] === '"e1"')).toBe(
      true,
    );
  });

  test("a hop off the listed hosts, a custom port or a sixth hop fails", async () => {
    for (const [to, result] of [
      ["https://other.test/a", "host is not in Web access"],
      ["https://check.test:8443/a", "host is not in Web access"],
      ["ftp://check.test/a", "could not connect"],
    ] as const) {
      const { seen, fetch } = site({ [ask.url]: moved(302, to) });
      expect(
        await check(ports({ ...listed, fetch }), clock().fake, ask, signal),
      ).toEqual({ result });
      expect(seen).toHaveLength(1);
    }
    const loop: Record<string, () => Response> = {};
    for (let i = 0; i < 7; i++) {
      loop[i === 0 ? ask.url : `${CHECK_URL}/${i}`] = moved(
        307,
        `${CHECK_URL}/${i + 1}`,
      );
    }
    const { seen, fetch } = site(loop);
    expect(await check(ports({ fetch }), clock().fake, ask, signal)).toEqual({
      result: "too many redirects",
    });
    expect(seen).toHaveLength(6);
  });

  test("a key the server echoes is scrubbed, the hash kept raw", async () => {
    const body = '{"token":"http-secret","escaped":"http\\u002dsecret"}';
    const { fetch } = site({ [ask.url]: () => new Response(body) });
    const got = await check(
      ports({
        fetch,
        credentials: () => [credential],
        readKey: () => ({ ok: true, key: "http-secret" }),
      }),
      clock().fake,
      ask,
      signal,
    );
    expect(got).toMatchObject({ result: "200", hash: sha256(body) });
    if (got?.result !== "200") throw new Error("no answer");
    expect(got.body).not.toContain("secret");
    expect(got.body).toContain("[key]");
  });

  test("a key never reaches another origin, and an unsigned check stays unsigned", async () => {
    const signedPorts = (fetch: typeof globalThis.fetch) =>
      ports({
        fetch,
        credentials: () => [credential],
        readKey: () => ({ ok: true, key: "http-secret" }),
      });
    const within = site({
      [ask.url]: moved(302, `${CHECK_URL}/b`),
      [`${CHECK_URL}/b`]: () => new Response(null, { status: 204 }),
    });
    expect(
      await check(signedPorts(within.fetch), clock().fake, ask, signal),
    ).toEqual({ result: "204" });
    expect(within.seen[1]!.headers["X-Api-Key"]).toBe("http-secret");
    const away = site({ [ask.url]: moved(302, "https://cdn.test/x") });
    expect(
      await check(signedPorts(away.fetch), clock().fake, ask, signal),
    ).toEqual({ result: "redirected outside its credential's URL" });
    expect(away.seen.map((call) => call.url)).toEqual([ask.url]);

    const server = site({
      [`${CHECK_URL}/feed`]: moved(301, "https://cdn.test/feed"),
    });
    expect(
      await check(
        ports({
          fetch: server.fetch,
          mcpServers: () => [
            { id: "m1", url: `${CHECK_URL}/mcp`, keyName: "mcp-k" },
          ],
          mcpKey: () => "mcp-secret",
        }),
        clock().fake,
        {
          ...ask,
          url: `${CHECK_URL}/feed`,
          servers: [{ serverId: "m1", read: true, write: false }],
        },
        signal,
      ),
    ).toEqual({ result: "redirected away from its MCP server" });
    expect(server.seen).toHaveLength(1);

    // from outside a prefix into it: no key goes
    const into = site({
      "https://cdn.test/a": moved(302, `${CHECK_URL}/b`),
      [`${CHECK_URL}/b`]: () => new Response(null, { status: 304 }),
    });
    expect(
      await check(
        signedPorts(into.fetch),
        clock().fake,
        { ...ask, url: "https://cdn.test/a" },
        signal,
      ),
    ).toEqual({ result: "304" });
    expect(into.seen.every((call) => !("X-Api-Key" in call.headers))).toBe(
      true,
    );
  });
});
