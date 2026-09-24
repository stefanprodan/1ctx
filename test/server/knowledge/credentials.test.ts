// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// curl's fetch in a mount with credentials, over a fake transport: the
// global fetch the vendored fetch calls is replaced, so every test here
// is serial.

import { expect, test } from "bun:test";
import {
  type CommandCredential,
  commandFetch,
} from "../../../src/server/knowledge/credentials.ts";
import type { CommandCaps } from "../../../src/server/knowledge/mount.ts";
import type { WebSnapshot } from "../../../src/shared/web.ts";
import { callCaps, run, setup } from "./helpers.ts";

const KEY = "quotes-key-0123456789";
const OTHER_KEY = "prices-key-9876543210";
const PREFIX = "https://quotes.example.test/api/v1/";

type Seen = { url: string; method: string; headers: Headers };

async function withTransport(
  handler: (url: string, seen: Seen) => Response | Promise<Response>,
  body: (seen: Seen[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const request = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      };
      seen.push(request);
      return handler(url, request);
    },
    { preconnect: original.preconnect },
  );
  try {
    await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const quotes = (
  fields: Partial<Extract<CommandCredential, { key: string }>> = {},
): CommandCredential => ({
  name: "quotes",
  prefix: PREFIX,
  key: KEY,
  header: "X-Api-Key",
  value: `Token ${KEY}`,
  methods: ["GET", "HEAD"],
  ...fields,
});

const prices: CommandCredential = {
  name: "prices",
  prefix: "https://prices.example.test/",
  key: OTHER_KEY,
  header: "Authorization",
  value: `Bearer ${OTHER_KEY}`,
  methods: ["GET"],
};

const ALL: WebSnapshot = { mode: "all", domains: [] };
const LISTED: WebSnapshot = { mode: "listed", domains: ["docs.example.test"] };
const limits = { timeoutMs: 2000, maxResponseSize: 4096 };

const text = (body: Uint8Array) => new TextDecoder().decode(body);

test.serial(
  "the header goes only on a URL under the credential's prefix",
  async () => {
    await withTransport(
      () => new Response("ok"),
      async (seen) => {
        const fetch = commandFetch(ALL, [quotes(), prices], limits);
        await fetch(`${PREFIX}quote?s=A`);
        await fetch("https://quotes.example.test/api/v2/quote");
        await fetch("https://elsewhere.example.test/");
        await fetch("https://prices.example.test/now");
        expect(seen.map((r) => r.headers.get("x-api-key"))).toEqual([
          `Token ${KEY}`,
          null,
          null,
          null,
        ]);
        expect(seen.map((r) => r.headers.get("authorization"))).toEqual([
          null,
          null,
          null,
          `Bearer ${OTHER_KEY}`,
        ]);
      },
    );
  },
);

test.serial(
  "an unsigned request redirected into a credential's prefix goes on unsigned",
  async () => {
    await withTransport(
      (url) =>
        url.startsWith("https://elsewhere.example.test/")
          ? new Response(null, {
              status: 302,
              headers: { location: `${PREFIX}quote` },
            })
          : new Response("landed"),
      async (seen) => {
        const fetch = commandFetch(ALL, [quotes()], limits);
        const result = await fetch("https://elsewhere.example.test/start");
        expect(text(result.body)).toBe("landed");
        expect(seen.map((r) => r.url)).toEqual([
          "https://elsewhere.example.test/start",
          `${PREFIX}quote`,
        ]);
        expect(seen.every((r) => !r.headers.has("x-api-key"))).toBe(true);
      },
    );
  },
);

test.serial(
  "a signed request follows redirects only inside its prefix",
  async () => {
    for (const [target, allowed] of [
      [`${PREFIX}next`, true],
      ["https://quotes.example.test/api/v2/next", false],
      ["https://prices.example.test/now", false],
      [`http://quotes.example.test/api/v1/next`, false],
      ["https://elsewhere.example.test/", false],
    ] as const) {
      await withTransport(
        (url) =>
          url === `${PREFIX}start`
            ? new Response(null, { status: 307, headers: { location: target } })
            : new Response("landed"),
        async (seen) => {
          const fetch = commandFetch(ALL, [quotes(), prices], limits);
          const answer = fetch(`${PREFIX}start`);
          if (allowed) {
            expect(text((await answer).body)).toBe("landed");
            expect(seen.map((r) => r.headers.get("x-api-key"))).toEqual([
              `Token ${KEY}`,
              `Token ${KEY}`,
            ]);
          } else {
            await expect(answer).rejects.toThrow(
              "Redirect target not in allow-list",
            );
            expect(seen.map((r) => r.url)).toEqual([`${PREFIX}start`]);
          }
        },
      );
    }
  },
);

test.serial("a credential's methods hold in every web mode", async () => {
  for (const web of [ALL, LISTED]) {
    await withTransport(
      () => new Response("ok"),
      async (seen) => {
        const fetch = commandFetch(web, [quotes()], limits);
        await fetch(`${PREFIX}q`, { method: "HEAD" });
        await expect(
          fetch(`${PREFIX}q`, { method: "POST", body: "x" }),
        ).rejects.toThrow(
          "HTTP method 'POST' not allowed by credential quotes. Allowed methods: GET, HEAD",
        );
        await expect(fetch(`${PREFIX}q`, { method: "DELETE" })).rejects.toThrow(
          "not allowed by credential quotes",
        );
        expect(seen.map((r) => r.method)).toEqual(["HEAD"]);
      },
    );
  }
});

test.serial(
  "a credential's prefix is reached in listed mode without its host",
  async () => {
    await withTransport(
      () => new Response("ok"),
      async (seen) => {
        const fetch = commandFetch(LISTED, [quotes()], limits);
        await fetch(`${PREFIX}q`);
        await fetch("https://docs.example.test/page", { method: "POST" });
        await expect(
          fetch("https://quotes.example.test/api/v2/q"),
        ).rejects.toThrow("Network access denied");
        expect(seen.map((r) => r.url)).toEqual([
          `${PREFIX}q`,
          "https://docs.example.test/page",
        ]);
        expect(seen[0]!.headers.get("x-api-key")).toBe(`Token ${KEY}`);
        expect(seen[1]!.headers.has("x-api-key")).toBe(false);
      },
    );
  },
);

test.serial(
  "a credential off, keyless, unusable or removed refuses by name before anything leaves",
  async () => {
    for (const [refused, words] of [
      ["off", "credential quotes is off in this chat"],
      ["missing", "credential quotes has no key"],
      ["unusable", "credential quotes has an unusable key"],
      ["deleted", "credential quotes was removed"],
    ] as const) {
      await withTransport(
        () => new Response("must not reach"),
        async (seen) => {
          const fetch = commandFetch(
            ALL,
            [{ name: "quotes", prefix: PREFIX, refused }],
            limits,
          );
          const failure = await fetch(`${PREFIX}q`).catch((error) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure.message).toBe(
            `Network access denied: ${words}: ${PREFIX}q`,
          );
          expect(failure.message).not.toContain("http-");
          await fetch("https://elsewhere.example.test/");
          expect(seen.map((r) => r.url)).toEqual([
            "https://elsewhere.example.test/",
          ]);
        },
      );
    }
  },
);

test.serial(
  "every key read is replaced in the body, headers, status text and final URL",
  async () => {
    await withTransport(
      (url) =>
        url === `${PREFIX}start`
          ? new Response(null, {
              status: 302,
              headers: { location: `${PREFIX}next?token=${KEY}` },
            })
          : new Response(`key=${KEY} other=${OTHER_KEY} key=${KEY}`, {
              status: 200,
              statusText: `OK ${KEY}`,
              headers: {
                "set-cookie": `session=${KEY}`,
                [`x-${KEY}`]: "named after the key",
                "x-plain": "kept",
                "content-length": "59",
              },
            }),
      async () => {
        const fetch = commandFetch(ALL, [quotes(), prices], limits);
        const result = await fetch(`${PREFIX}start`);
        const body = text(result.body);
        expect(body).toBe(
          "key=[credential quotes] other=[credential prices] key=[credential quotes]",
        );
        expect(result.headers["content-length"]).toBe(
          String(result.body.byteLength),
        );
        expect(result.headers["set-cookie"]).toBe(
          "session=[credential quotes]",
        );
        expect(result.headers["x-plain"]).toBe("kept");
        expect(Object.keys(result.headers).join()).not.toContain(KEY);
        expect(result.statusText).toBe("OK [credential quotes]");
        expect(result.url).toBe(`${PREFIX}next?token=[credential quotes]`);
      },
    );
  },
);

test.serial(
  "binary bytes around a key are kept and a grown body past the cap is refused",
  async () => {
    const key = new TextEncoder().encode(KEY);
    const bytes = new Uint8Array([0, 255, ...key, 7, 128, ...key]);
    await withTransport(
      () => new Response(bytes),
      async () => {
        const fetch = commandFetch(ALL, [quotes()], limits);
        const result = await fetch(`${PREFIX}file`);
        const label = new TextEncoder().encode("[credential quotes]");
        expect([...result.body]).toEqual([0, 255, ...label, 7, 128, ...label]);
        // a label longer than the key grows the body
        const small = commandFetch(
          ALL,
          [quotes({ name: "quotes-for-the-desk" })],
          {
            ...limits,
            maxResponseSize: bytes.byteLength + 2,
          },
        );
        await expect(small(`${PREFIX}file`)).rejects.toThrow(
          `Response body too large (max: ${bytes.byteLength + 2} bytes)`,
        );
      },
    );
  },
);

test.serial(
  "a fetch error is rebuilt from its first line without the key",
  async () => {
    await withTransport(
      (url) => {
        if (url.startsWith("https://elsewhere.example.test/")) {
          throw new TypeError(`connection to ${KEY} failed\nsecond ${KEY}`);
        }
        return new Response(null, {
          status: 302,
          headers: { location: `https://elsewhere.example.test/?k=${KEY}` },
        });
      },
      async () => {
        const fetch = commandFetch(ALL, [quotes()], limits);
        const redirect = await fetch(`${PREFIX}start`).catch((error) => error);
        expect(redirect.message).toBe(
          "Redirect target not in allow-list: https://elsewhere.example.test/?k=[credential quotes]",
        );
        const thrown = await fetch("https://elsewhere.example.test/").catch(
          (error) => error,
        );
        expect(thrown.name).toBe("TypeError");
        expect(thrown.message).toBe("connection to [credential quotes] failed");
        expect(thrown.stack ?? "").not.toContain(KEY);
      },
    );
  },
);

test.serial(
  "curl in a mount signs, refuses and redacts, and never prints the key",
  async () => {
    const s = setup();
    const caps = (credentials: CommandCredential[]): CommandCaps => ({
      ...callCaps,
      web: ALL,
      fetchDeadlineMs: 2000,
      fetchBodyBytes: 4096,
      credentials,
    });
    try {
      await withTransport(
        (_url, request) =>
          new Response(`echo ${request.headers.get("x-api-key")}`, {
            headers: { "x-echo": KEY },
          }),
        async (seen) => {
          const signed = await run(
            s,
            `curl -sS -i ${PREFIX}q; curl -sS -v -o /tmp/out ${PREFIX}q; cat /tmp/out`,
            caps([quotes()]),
          );
          expect(signed.error, signed.content).toBe(false);
          expect(signed.content).toContain("echo Token [credential quotes]");
          expect(signed.content).toContain("x-echo: [credential quotes]");
          expect(signed.content).not.toContain(KEY);
          expect(seen).toHaveLength(2);
          const off = await run(
            s,
            `curl -sS ${PREFIX}q`,
            caps([{ name: "quotes", prefix: PREFIX, refused: "off" }]),
          );
          expect(off.error).toBe(true);
          expect(off.content).toContain(
            "curl: (7) Network access denied: credential quotes is off in this chat",
          );
          const method = await run(
            s,
            `curl -sS -X POST -d x ${PREFIX}q`,
            caps([quotes()]),
          );
          expect(method.content).toContain("curl: (3) HTTP method 'POST'");
          expect(seen).toHaveLength(2);
        },
      );
    } finally {
      s.db.close();
    }
  },
);

test.serial(
  "a signed request that sets a routing header is refused before it leaves",
  async () => {
    await withTransport(
      () => new Response("ok"),
      async (seen) => {
        const fetch = commandFetch(ALL, [quotes()], limits);
        const names = [
          "Host",
          "forwarded",
          "X-Forwarded-Host",
          "x-forwarded-for",
          "X-Forwarded-Proto",
          "x-original-url",
          "X-Rewrite-Url",
          "x-http-method-override",
          "X-HTTP-Method",
          "x-method-override",
        ];
        for (const name of names) {
          for (const headers of [
            { [name]: "attacker.example" },
            new Headers({ [name]: "attacker.example" }),
          ]) {
            const refused = await fetch(`${PREFIX}q`, { headers }).catch(
              (error) => error,
            );
            expect(refused.name).toBe("NetworkAccessDeniedError");
            expect(refused.message).toBe(
              `Network access denied: credential quotes refuses the ${name.toLowerCase()} header: ${PREFIX}q`,
            );
          }
        }
        expect(seen).toHaveLength(0);
        await fetch(`${PREFIX}q`, { headers: { Accept: "text/plain" } });
        expect(seen).toHaveLength(1);
      },
    );
  },
);

test.serial("an unsigned request may not name another host", async () => {
  await withTransport(
    () => new Response("ok"),
    async (seen) => {
      for (const web of [ALL, LISTED]) {
        const fetch = commandFetch(web, [quotes()], limits);
        for (const name of ["Host", "Forwarded", "x-forwarded-host"]) {
          const refused = await fetch("https://docs.example.test/", {
            headers: new Headers({ [name]: "internal.example" }),
          }).catch((error) => error);
          expect(refused.message).toBe(
            `Network access denied: the ${name.toLowerCase()} header is not allowed: https://docs.example.test/`,
          );
        }
      }
      expect(seen).toHaveLength(0);
      const fetch = commandFetch(ALL, [quotes()], limits);
      await fetch("https://docs.example.test/", {
        headers: { "X-Forwarded-For": "10.0.0.1" },
      });
      expect(seen).toHaveLength(1);
    },
  );
});

test.serial("a key echoed JSON-escaped is redacted too", async () => {
  const key = 'abc/def+ghi=jkl<01>&"23\\45';
  const hex = (char: string) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const escaped = [
    JSON.stringify(key).slice(1, -1),
    JSON.stringify(key).slice(1, -1).replaceAll("/", "\\/"),
    [...key].map((c) => (/[A-Za-z0-9]/.test(c) ? c : hex(c))).join(""),
    [...key]
      .map((c) => (/[A-Za-z0-9]/.test(c) ? c : hex(c).toUpperCase()))
      .join("")
      .replaceAll("\\U", "\\u"),
    [...key].map((c) => (/[A-Za-z0-9._~-]/.test(c) ? c : hex(c))).join(""),
    // Go's encoder: <, > and & as \u, the rest as JSON, / kept
    JSON.stringify(key)
      .slice(1, -1)
      .replace(/[<>&]/g, (c) => hex(c)),
  ];
  await withTransport(
    () =>
      new Response(escaped.map((form) => `{"k":"${form}"}`).join("\n"), {
        headers: { "x-echo": escaped[1]! },
      }),
    async () => {
      const fetch = commandFetch(
        ALL,
        [quotes({ key, value: `Token ${key}` })],
        limits,
      );
      const result = await fetch(`${PREFIX}echo`);
      const body = text(result.body);
      for (const form of escaped) expect(body).not.toContain(form);
      expect(body.split("\n")).toEqual(
        escaped.map(() => '{"k":"[credential quotes]"}'),
      );
      expect(result.headers["x-echo"]).toBe("[credential quotes]");
    },
  );
});
