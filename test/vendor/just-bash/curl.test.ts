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
    // (1ctx curl-bytes) a byte that is not UTF-8 is sent as it is
    test(`keeps invalid UTF-8 in ${flags}`, async () => {
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
      expect(body).toBeInstanceOf(Uint8Array);
      const text = String.fromCharCode(...(body as Uint8Array));
      if (flags.startsWith("-d")) {
        expect(text).toBe("\xff\xfe\x80A");
      } else {
        expect(text).toContain('name="f"; filename="payload"');
        expect(text).toContain("\r\n\r\n\xff\xfe\x80\0\r\nA\r\n");
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

// (1ctx curl-bytes) a file curl reads for a request body is sent as bytes
describe("curl sends a file's bytes", () => {
  const BYTES = Uint8Array.from([0xff, 0xfe, 0x41, 0x0a, 0xe9]);

  async function sent(command: string): Promise<Uint8Array> {
    let body: string | Uint8Array | undefined;
    const fs = new InMemoryFs();
    fs.writeFileSync("/f", BYTES);
    const bash = new Bash({
      fs,
      cwd: "/",
      fetch: async (_url, options) => {
        body = options?.body;
        return response();
      },
    });
    const result = await bash.exec(command);
    expect(result.exitCode).toBe(0);
    return typeof body === "string"
      ? new TextEncoder().encode(body)
      : (body ?? new Uint8Array());
  }

  const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

  test("-d @file strips NUL, CR and LF and keeps every other byte", async () => {
    expect(await sent(`curl -s -d @/f ${URL}`)).toEqual(
      Uint8Array.from([0xff, 0xfe, 0x41, 0xe9]),
    );
  });

  test("--data-urlencode @file encodes each byte in uppercase hex", async () => {
    expect(await sent(`curl -s --data-urlencode n@/f ${URL}`)).toEqual(
      bytes("n=%FF%FEA%0A%E9"),
    );
  });

  test("-F f=@file sends the file as it is", async () => {
    const body = await sent(`curl -s -F f=@/f ${URL}`);
    const text = String.fromCharCode(...body);
    expect(text).toContain(
      `filename="f"\r\n\r\n${String.fromCharCode(...BYTES)}\r\n`,
    );
  });

  test("-T file uploads the file as it is", async () => {
    expect(await sent(`curl -s -T /f ${URL}`)).toEqual(BYTES);
  });
});

// (1ctx curl-timeout) -m and --connect-timeout as curl 8.21 reads seconds
describe("curl timeouts", () => {
  async function timeout(flags: string) {
    let seen = null as number | undefined | null;
    const bash = new Bash({
      fetch: async (_url, options) => {
        seen = options?.timeoutMs;
        return response();
      },
    });
    const result = await bash.exec(`curl -s ${flags} ${URL}`);
    return { seen, stderr: result.stderr, exitCode: result.exitCode };
  }

  test("fractions become whole milliseconds", async () => {
    for (const [flags, ms] of [
      ["-m 1.0001", 1000],
      ["-m 0.5", 500],
      ["-m 1.5", 1500],
      ["-m1.25", 1250],
      ["--max-time=2.999", 2999],
      ["--connect-timeout 1.5", 1500],
      ["--connect-timeout 1 -m 3", 3000],
      ["-m 1e300", 1000],
      ["-m 1,5", 1000],
    ] as const) {
      expect(await timeout(flags)).toEqual({
        seen: ms,
        stderr: "",
        exitCode: 0,
      });
    }
  });

  test("a huge value is clamped to what a timer holds", async () => {
    expect((await timeout("-m 9223372036854774")).seen).toBe(2 ** 31 - 1);
  });

  test("zero, or less than a millisecond, is no limit", async () => {
    for (const flags of ["-m 0", "-m 0.0001", "-m 0x10"]) {
      expect((await timeout(flags)).seen).toBeUndefined();
    }
  });

  test("a value curl refuses is its exit 2", async () => {
    const TRY =
      "curl: try 'curl --help' or 'curl --manual' for more information\n";
    for (const [flags, problem] of [
      ["-m abc", "-m: expected a proper numerical parameter"],
      ["-m -1", "-m: expected a proper numerical parameter"],
      ["-m .5", "-m: expected a proper numerical parameter"],
      ["-m inf", "-m: expected a proper numerical parameter"],
      ["-m 9223372036854775", "-m: expected a proper numerical parameter"],
      ["-m 1.", "-m: too large number"],
      ["--max-time abc", "--max-time: expected a proper numerical parameter"],
      ["--max-time=x", "--max-time=x: expected a proper numerical parameter"],
      [
        "--connect-timeout -1",
        "--connect-timeout: expected a proper numerical parameter",
      ],
    ] as const) {
      expect(await timeout(flags)).toEqual({
        seen: null,
        stderr: `curl: option ${problem}\n${TRY}`,
        exitCode: 2,
      });
    }
  });

  test("a missing value is curl's exit 2", async () => {
    const bash = new Bash({ fetch: async () => response() });
    const result = await bash.exec("curl -s -m");
    expect(result.stderr).toStartWith("curl: option -m: requires parameter\n");
    expect(result.exitCode).toBe(2);
  });
});

// (1ctx curl-urlencode) curl 8.21 writes its escapes in uppercase hex
describe("curl --data-urlencode", () => {
  async function request(command: string) {
    let seen = { url: "", body: "" };
    const fs = new InMemoryFs();
    fs.writeFileSync("/f", Uint8Array.from([0xff, 0x2a]));
    const bash = new Bash({
      fs,
      cwd: "/",
      fetch: async (url, options) => {
        seen = { url, body: String(options?.body ?? "") };
        return response();
      },
    });
    expect((await bash.exec(command)).exitCode).toBe(0);
    return seen;
  }

  test("encodes in uppercase hex in the body", async () => {
    expect(
      (await request(`curl -s --data-urlencode "a=é!'()*~ x" ${URL}`)).body,
    ).toBe("a=%C3%A9%21%27%28%29%2A~+x");
  });

  test("encodes in uppercase hex in the query under -G", async () => {
    const { url } = await request(
      `curl -s -G --data-urlencode "a=é*" --data-urlencode n@/f ${URL}`,
    );
    expect(url).toBe(`${URL}?a=%C3%A9%2A&n=%FF%2A`);
  });
});
