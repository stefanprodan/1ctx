// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What our changes to the vendored just-bash hold, against a loopback
// server the test starts: curl never follows a redirect off http, since Bun's fetch reads
// file: URLs from the host's disk, and a response refused for its length
// lets go of its body. The suite reaches no network. A command we removed
// is not found like any other.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

type Network = NonNullable<ConstructorParameters<typeof Bash>[0]>["network"];

function serve(handler: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const full: Network = {
  dangerouslyAllowFullInternetAccess: true,
  denyPrivateRanges: false,
};

describe("the vendored just-bash", () => {
  for (const target of [
    "file:///etc/hosts",
    "data:text/plain,leak",
    "ftp://127.0.0.1/x",
  ]) {
    test(`curl under full access refuses a redirect to ${target}`, async () => {
      const s = serve(
        () =>
          new Response(null, { status: 302, headers: { location: target } }),
      );
      try {
        const result = await new Bash({ network: full }).exec(
          `curl -sSL ${s.url}/`,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Redirect target not in allow-list");
      } finally {
        s.stop();
      }
    });
  }

  test("curl under full access still follows a redirect to http", async () => {
    const s = serve((req) =>
      new URL(req.url).pathname === "/to"
        ? new Response("landed")
        : new Response(null, { status: 302, headers: { location: "/to" } }),
    );
    try {
      const result = await new Bash({ network: full }).exec(
        `curl -sSL ${s.url}/`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("landed");
    } finally {
      s.stop();
    }
  });

  test("a response over the size cap is refused and its body cancelled", async () => {
    let cancelled = false;
    const s = serve(() => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { "content-length": "1048576" } });
    });
    try {
      const result = await new Bash({
        network: { ...full, maxResponseSize: 4096 },
      }).exec(`curl -sS ${s.url}/`);
      expect(result.exitCode).not.toBe(0);
      // the server sees the abort a moment after the client lets go
      for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(10);
      expect(cancelled).toBe(true);
    } finally {
      s.stop();
    }
  });

  for (const name of ["python", "python3", "sqlite3", "node"]) {
    test(`${name} is not found like any other command`, async () => {
      const result = await new Bash().exec(`${name} -c 1`);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe(`bash: ${name}: command not found\n`);
    });
  }
});
