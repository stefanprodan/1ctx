// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { Bash, type FetchResult, type SecureFetch } from "just-bash";
import { curlCommand } from "../../../vendor/just-bash/src/commands/curl/curl.ts";
import { bytesFromUint8Array } from "../../../vendor/just-bash/src/encoding.ts";
import { InMemoryFs } from "../../../vendor/just-bash/src/fs/in-memory-fs/in-memory-fs.ts";
import { resolveLimits } from "../../../vendor/just-bash/src/limits.ts";

const URL = "https://curl.example.test/body";
const BODY = new TextEncoder().encode("OK");
const HEADERS = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n";
const VERBOSE = `> GET ${URL}\n>\n< HTTP/1.1 200 OK\n< content-type: text/plain\n<\n`;

function response(): FetchResult {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
    body: BODY,
    url: URL,
  };
}

describe("curl write-out", () => {
  for (const destination of ["", "-o /out", "-O"]) {
    for (const verbose of [false, true]) {
      for (const dump of [false, true]) {
        const flags = `${destination} ${verbose ? "-v" : ""} ${dump ? "-D -" : ""}`;
        test(`appends write-out exactly once with ${flags}`, async () => {
          const bash = new Bash({ cwd: "/", fetch: async () => response() });
          const result = await bash.exec(
            `curl ${flags} -w 'X%{http_code}:%{size_download}' ${URL}`,
          );
          const stdout =
            (dump ? HEADERS : "") +
            (verbose ? VERBOSE : "") +
            (!destination || verbose ? "OK" : "") +
            "X200:2";
          expect(result).toMatchObject({ stdout, stderr: "", exitCode: 0 });
          if (destination) {
            const path = destination === "-O" ? "/body" : "/out";
            expect(await bash.fs.readFileBuffer(path)).toEqual(BODY);
          }
        });
      }
    }
  }

  test("keeps every supplied redirect header before verbose output and write-out", async () => {
    const bash = new Bash({
      fetch: async () => ({
        ...response(),
        redirectChain: [
          {
            status: 302,
            statusText: "Found",
            headers: { location: URL },
          },
        ],
      }),
    });
    const result = await bash.exec(`curl -v -o /out -D - -w X ${URL}`);
    expect(result).toMatchObject({
      stdout:
        `HTTP/1.1 302 Found\r\nlocation: ${URL}\r\n\r\n` +
        HEADERS +
        VERBOSE +
        "OKX",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.fs.readFileBuffer("/out")).toEqual(BODY);
  });
});

describe("curl text file uploads", () => {
  for (const flags of ["-d @/payload", "-F f=@/payload"]) {
    test(`decodes invalid UTF-8 in ${flags}`, async () => {
      const fetch = mock<SecureFetch>(async () => response());
      const bash = new Bash({
        files: {
          "/payload": new Uint8Array([0xff, 0xfe, 0x80, 0, 13, 10, 65]),
        },
        fetch,
      });
      const result = await bash.exec(`curl ${flags} ${URL}`);
      expect(result.exitCode).toBe(0);
      const body = fetch.mock.calls[0]?.[1]?.body;
      expect(typeof body).toBe("string");
      if (flags.startsWith("-d")) {
        expect(body).toBe("\ufffd\ufffd\ufffdA");
      } else {
        expect(body).toContain('name="f"; filename="payload"');
        expect(body).toContain("\r\n\r\n\ufffd\ufffd\ufffd\0\r\nA\r\n");
      }
    });
  }
});

describe("curl stdin bytes on Bun", () => {
  test.serial(
    "supports text and binary stdin request bodies without Buffer",
    async () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
      if (!descriptor) throw new Error("missing Buffer descriptor");
      const fetch = mock(async () => response());
      const ctx = {
        fs: new InMemoryFs(),
        cwd: "/",
        env: new Map<string, string>(),
        stdin: bytesFromUint8Array(new Uint8Array([0x80, 0xff])),
        limits: resolveLimits(),
        fetch,
      };
      try {
        Object.defineProperty(globalThis, "Buffer", {
          ...descriptor,
          value: undefined,
        });
        const text = await curlCommand.execute(["-d", "hello=world", URL], ctx);
        const binary = await curlCommand.execute(
          ["--data-binary", "@-", "-d", "\u00e9", URL],
          ctx,
        );
        expect(text).toMatchObject({ stdout: "OK", stderr: "", exitCode: 0 });
        expect(binary).toMatchObject({ stdout: "OK", stderr: "", exitCode: 0 });
        expect(fetch).toHaveBeenNthCalledWith(
          1,
          URL,
          expect.objectContaining({ body: "hello=world" }),
        );
        expect(fetch).toHaveBeenLastCalledWith(
          URL,
          expect.objectContaining({
            body: new Uint8Array([0x80, 0xff, 0x26, 0xc3, 0xa9]),
          }),
        );
      } finally {
        Object.defineProperty(globalThis, "Buffer", descriptor);
      }
    },
  );

  test.serial(
    "preserves invalid UTF-8 bytes in binary stdin request bodies",
    async () => {
      const original = globalThis.fetch;
      const fetch = mock(async () => new Response("OK"));
      globalThis.fetch = Object.assign(fetch, {
        preconnect: original.preconnect,
      });
      try {
        const bash = new Bash({
          files: { "/payload": new Uint8Array([0x80, 0xff]) },
          network: {
            allowedUrlPrefixes: [URL],
            allowedMethods: ["POST"],
          },
        });
        const result = await bash.exec(
          `cat /payload | curl --data-binary @- ${URL}`,
        );
        expect(result).toMatchObject({ stdout: "OK", stderr: "", exitCode: 0 });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
          URL,
          expect.objectContaining({ body: new Uint8Array([0x80, 0xff]) }),
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );

  test.serial(
    "consumes stdin once across ordered data references",
    async () => {
      const original = globalThis.fetch;
      const fetch = mock(async () => new Response("OK"));
      globalThis.fetch = Object.assign(fetch, {
        preconnect: original.preconnect,
      });
      try {
        const bash = new Bash({
          network: {
            allowedUrlPrefixes: [URL],
            allowedMethods: ["POST"],
          },
        });
        const result = await bash.exec(`curl -d @- -d @- ${URL}`, {
          stdin: "abc",
        });
        expect(result).toMatchObject({ stdout: "OK", stderr: "", exitCode: 0 });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
          URL,
          expect.objectContaining({ body: "abc&" }),
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );
});
