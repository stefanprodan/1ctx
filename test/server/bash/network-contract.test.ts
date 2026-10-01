// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { createSecureFetch, type FetchResult } from "just-bash";
import {
  type CommandCredential,
  redactResult,
} from "../../../src/server/bash/credentials.ts";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import { callCaps, run, seedScratch, setup } from "./helpers.ts";

const URL = "https://network.example.test/";
const KEY = "synthetic-network-key";
const LABEL = "[credential unrelated]";
const credential: CommandCredential = {
  name: "unrelated",
  prefix: "https://signed.example.test/api/",
  key: KEY,
  header: "Authorization",
  value: `Bearer ${KEY}`,
  methods: ["GET", "POST"],
};
const limits = { timeoutMs: 1000, maxResponseSize: 4096 };
const caps: CommandCaps = {
  ...callCaps,
  web: { mode: "all", domains: [] },
  fetchDeadlineMs: limits.timeoutMs,
  fetchBodyBytes: limits.maxResponseSize,
  resultCut: 4096,
};

type Seen = { url: string; init: RequestInit };

async function transport(
  handler: (request: Seen) => Response | Promise<Response>,
  body: (seen: Seen[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const request = {
        url: input instanceof Request ? input.url : String(input),
        init,
      };
      seen.push(request);
      return handler(request);
    },
    { preconnect: original.preconnect },
  );
  try {
    await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

for (const source of ["@/tmp/payload", "@-"]) {
  test.serial(
    `a real worker posts binary ${source} once without decoding`,
    async () => {
      const bytes = new Uint8Array([0, 0x80, 0xff, 13, 10, 0xc3, 0xa9]);
      const s = setup();
      seedScratch(s, {
        written: [{ path: "payload", data: bytes, mode: 0o644 }],
      });
      try {
        await transport(
          () => new Response("posted"),
          async (seen) => {
            const result = await run(
              s,
              `${source === "@-" ? "cat /tmp/payload | " : ""}curl -sS --data-binary ${source} ${URL}`,
              { ...caps, callTimeoutMs: 1000 },
            );
            expect(seen).toHaveLength(1);
            expect(seen[0].init.method).toBe("POST");
            expect(seen[0].init.body).toBeInstanceOf(Uint8Array);
            expect(seen[0].init.body).toEqual(bytes);
            expect(result.error, result.content).toBe(false);
            expect(result.content).toContain("posted");
            expect(s.bash.scratch.read(s.session.id).entries[0].data).toEqual(
              bytes,
            );
          },
        );
      } finally {
        s.db.close();
      }
    },
  );
}

for (const loaded of [false, true]) {
  test.serial(
    `a real worker dumps every redirect with unrelated key loaded=${loaded}`,
    async () => {
      const s = setup();
      const secret = loaded ? KEY : "plain";
      const label = loaded ? LABEL : "plain";
      try {
        await transport(
          ({ url }) => {
            const hop = new globalThis.URL(url).pathname;
            const status = hop === "/" ? 302 : hop === "/next" ? 307 : 200;
            return new Response(status === 200 ? "done" : null, {
              status,
              statusText: `${status} ${secret}`,
              headers: {
                ...(status === 200
                  ? {}
                  : { location: status === 302 ? "/next" : "/final" }),
                "x-echo": secret,
                [`x-${secret.toUpperCase()}`]: "sensitive name",
              },
            });
          },
          async (seen) => {
            const result = await run(s, `curl -sS -L -D - ${URL}`, {
              ...caps,
              credentials: loaded ? [credential] : [],
            });
            expect(result.error, result.content).toBe(false);
            for (const status of [302, 307, 200]) {
              expect(result.content).toContain(
                `HTTP/1.1 ${status} ${status} ${label}\r\n`,
              );
            }
            expect(result.content.match(/x-echo: /g)).toHaveLength(3);
            expect(result.content.indexOf("HTTP/1.1 302")).toBeLessThan(
              result.content.indexOf("HTTP/1.1 307"),
            );
            expect(result.content.indexOf("HTTP/1.1 307")).toBeLessThan(
              result.content.indexOf("HTTP/1.1 200"),
            );
            if (loaded) {
              expect(result.content.toLowerCase()).not.toContain(KEY);
              expect(result.content).not.toContain("sensitive name");
            }
            expect(seen).toHaveLength(3);
            expect(
              seen.every(
                ({ init }) => !new Headers(init.headers).has("authorization"),
              ),
            ).toBe(true);
          },
        );
      } finally {
        s.db.close();
      }
    },
  );
}

test("redirect redaction scrubs every hop before it crosses the worker boundary", () => {
  const result: FetchResult = {
    status: 200,
    statusText: "OK",
    headers: {},
    body: new Uint8Array(),
    url: URL,
    redirectChain: [302, 307].map((status) => ({
      status,
      statusText: `hop ${KEY}`,
      headers: { [`x-${KEY.toUpperCase()}`]: "drop", "x-echo": KEY },
    })),
  };
  const clean = redactResult(result, [{ key: KEY, label: LABEL }], 4096);
  expect(clean.redirectChain).toEqual(
    [302, 307].map((status) => ({
      status,
      statusText: `hop ${LABEL}`,
      headers: { "x-echo": LABEL },
    })),
  );
  expect(JSON.stringify(clean).toLowerCase()).not.toContain(KEY);
  expect(result.redirectChain?.[0].statusText).toBe(`hop ${KEY}`);
});

for (const target of [
  "file://127.0.0.1/not-a-real-fixture",
  "ftp://10.0.0.1/blocked",
  "custom://[::1]/blocked",
  "data:text/plain,blocked",
]) {
  test.serial(
    `a real worker refuses a private-host redirect to ${target}`,
    async () => {
      const s = setup();
      try {
        await transport(
          ({ url }) =>
            new Response(null, {
              status: 302,
              headers: {
                location: url === URL ? "http://127.0.0.1/hop" : target,
              },
            }),
          async (seen) => {
            const result = await run(s, `curl -sSL ${URL}`, caps);
            expect(result.error).toBe(true);
            expect(result.content).toContain(
              "Redirect target not in allow-list",
            );
            expect(seen.map(({ url }) => url)).toEqual([
              URL,
              "http://127.0.0.1/hop",
            ]);
          },
        );
      } finally {
        s.db.close();
      }
    },
  );
}

for (const reason of ["length", "location"]) {
  test.serial(`a real worker cancels a refused ${reason} body`, async () => {
    const s = setup();
    let cancelled = 0;
    let release: () => void = () => {};
    const body = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled++;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
      { highWaterMark: 0 },
    );
    try {
      await transport(
        () =>
          new Response(
            body,
            reason === "length"
              ? { headers: { "content-length": "8192" } }
              : { status: 302, headers: { location: "http://[" } },
          ),
        async (seen) => {
          const result = await run(s, `curl -sSL ${URL}`, caps);
          expect(result.error).toBe(true);
          expect(result.content).not.toContain("deadline");
          expect(result.content).not.toContain("aborted");
          expect(cancelled).toBe(1);
          expect(seen).toHaveLength(1);
          if (reason === "length")
            expect(result.content).toContain("Response body too large");
        },
      );
    } finally {
      release();
      s.db.close();
    }
  });
}

test.serial(
  "a real worker strips caller credentials only after crossing origins",
  async () => {
    const s = setup();
    const urls = [URL, `${URL}same`, "http://127.0.0.1/cross", `${URL}back`];
    try {
      await transport(
        ({ url }) => {
          const next = urls[urls.indexOf(url) + 1];
          return next
            ? new Response(null, { status: 307, headers: { location: next } })
            : new Response("done");
        },
        async (seen) => {
          const result = await run(
            s,
            `curl -sSL -H 'Authorization: caller' -H 'Cookie: session=caller' -H 'X-Keep: yes' ${URL}`,
            caps,
          );
          expect(result.error, result.content).toBe(false);
          expect(seen.map(({ url }) => url)).toEqual(urls);
          const headers = seen.map(({ init }) => new Headers(init.headers));
          expect(headers.map((h) => h.get("authorization"))).toEqual([
            "caller",
            "caller",
            null,
            null,
          ]);
          expect(headers.map((h) => h.get("cookie"))).toEqual([
            "session=caller",
            "session=caller",
            null,
            null,
          ]);
          expect(headers.map((h) => h.get("x-keep"))).toEqual([
            "yes",
            "yes",
            "yes",
            "yes",
          ]);
        },
      );
    } finally {
      s.db.close();
    }
  },
);

test.serial(
  "a real worker signs every in-prefix hop and refuses an escape",
  async () => {
    const s = setup();
    const first = `${credential.prefix}start`;
    const next = `${credential.prefix}next`;
    try {
      await transport(
        ({ url }) =>
          new Response(null, {
            status: 307,
            headers: { location: url === first ? next : URL },
          }),
        async (seen) => {
          const result = await run(s, `curl -sSL ${first}`, {
            ...caps,
            credentials: [credential],
          });
          expect(result.error).toBe(true);
          expect(result.content).toContain("Redirect target not in allow-list");
          expect(result.content).not.toContain(KEY);
          expect(seen.map(({ url }) => url)).toEqual([first, next]);
          expect(
            seen.map(({ init }) =>
              new Headers(init.headers).get("authorization"),
            ),
          ).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
        },
      );
    } finally {
      s.db.close();
    }
  },
);

test.serial(
  "the opt-out adapter uses the current ambient fetch for every permitted host",
  async () => {
    for (const full of [false, true]) {
      for (const url of [
        URL,
        "https://93.184.216.34/",
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://localhost/",
      ]) {
        const fetch = createSecureFetch({
          ...(full
            ? { dangerouslyAllowFullInternetAccess: true }
            : { allowedUrlPrefixes: [url] }),
          denyPrivateRanges: false,
        });
        for (const text of ["first", "replacement"]) {
          await transport(
            () => new Response(text),
            async (seen) => {
              const result = await fetch(url);
              expect(new TextDecoder().decode(result.body)).toBe(text);
              expect(seen.map(({ url }) => url)).toEqual([url]);
            },
          );
        }
      }
    }
  },
);
