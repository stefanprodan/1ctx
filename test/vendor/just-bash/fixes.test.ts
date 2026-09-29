// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What our changes to the vendored just-bash hold, against a loopback
// server the test starts: curl never follows a redirect off http, since Bun's fetch reads
// file: URLs from the host's disk, and a response refused for its length
// lets go of its body. The suite reaches no network. A command we removed
// is not found like any other, ls -t sorts by time, and curl, jq and yq
// answer --version.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

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

  test("ls -t lists the newest first, a tie by name, and -r reverses it", async () => {
    const fs = new InMemoryFs();
    const at = (day: number) => ({ mtime: new Date(Date.UTC(2026, 0, day)) });
    fs.writeFileSync("/d/a", "", undefined, at(2));
    fs.writeFileSync("/d/b", "", undefined, at(3));
    fs.writeFileSync("/d/c", "", undefined, at(1));
    fs.writeFileSync("/d/d", "", undefined, at(3));
    const bash = new Bash({ fs });
    expect((await bash.exec("ls -t /d")).stdout).toBe("b\nd\na\nc\n");
    expect((await bash.exec("ls -tr /d")).stdout).toBe("c\na\nd\nb\n");
    expect((await bash.exec("ls /d")).stdout).toBe("a\nb\nc\nd\n");
  });

  test("ls lists file operands as one sorted block before the directories", async () => {
    const fs = new InMemoryFs();
    const at = (day: number) => ({ mtime: new Date(Date.UTC(2026, 0, day)) });
    fs.writeFileSync("/d/a.md", "", undefined, at(2));
    fs.writeFileSync("/d/b.md", "", undefined, at(3));
    fs.writeFileSync("/d/c.md", "", undefined, at(1));
    fs.writeFileSync("/d/sub/x", "");
    const bash = new Bash({ fs });
    expect((await bash.exec("ls -t /d/*.md")).stdout).toBe(
      "/d/b.md\n/d/a.md\n/d/c.md\n",
    );
    expect((await bash.exec("ls -tr /d/*.md")).stdout).toBe(
      "/d/c.md\n/d/a.md\n/d/b.md\n",
    );
    expect((await bash.exec("cd /d && ls sub c.md a.md")).stdout).toBe(
      "a.md\nc.md\n\nsub:\nx\n",
    );
  });

  test("ls takes the last of -S and -t, ties by name, and -d as one block", async () => {
    const fs = new InMemoryFs();
    const at = (day: number) => ({ mtime: new Date(Date.UTC(2026, 0, day)) });
    fs.writeFileSync("/d/ls-a", "aa", undefined, at(1));
    fs.writeFileSync("/d/ls-b", "bb", undefined, at(3));
    fs.writeFileSync("/d/ls-c", "cccc", undefined, at(2));
    fs.mkdirSync("/d/sub");
    await fs.utimes("/d/sub", new Date(0), new Date(Date.UTC(2026, 0, 4)));
    const bash = new Bash({ fs, cwd: "/d" });
    // what GNU ls 9 prints for the same files
    const cases: [string, string][] = [
      ["ls -St ls-a ls-b ls-c", "ls-b\nls-c\nls-a\n"],
      ["ls -tS ls-a ls-b ls-c", "ls-c\nls-a\nls-b\n"],
      ["ls -S ls-b ls-a", "ls-a\nls-b\n"],
      ["ls -dt ls-a ls-b ls-c", "ls-b\nls-c\nls-a\n"],
      ["ls -dt ls-a sub ls-b", "sub\nls-b\nls-a\n"],
    ];
    for (const [command, stdout] of cases)
      expect((await bash.exec(command)).stdout, command).toBe(stdout);
  });

  test("ls -t sorts a link by its own time", async () => {
    const fs = new InMemoryFs();
    const at = (day: number) => ({ mtime: new Date(Date.UTC(2026, 0, day)) });
    fs.writeFileSync("/d/new", "", undefined, at(3));
    fs.writeFileSync("/d/old", "", undefined, at(1));
    await fs.symlink("old", "/d/link");
    const bash = new Bash({ fs });
    // the link is made now, after both files
    expect((await bash.exec("ls -t /d")).stdout).toBe("link\nnew\nold\n");
  });

  for (const name of ["python", "python3", "sqlite3", "node"]) {
    test(`${name} is not found like any other command`, async () => {
      const result = await new Bash().exec(`${name} -c 1`);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe(`bash: ${name}: command not found\n`);
    });
  }

  for (const [command, line] of [
    ["jq --version", "jq-1.8.2 (just-bash, compatible)"],
    ["jq -V", "jq-1.8.2 (just-bash, compatible)"],
    [
      "yq --version",
      "yq (https://github.com/mikefarah/yq/) version v4.53.3 (just-bash, compatible)",
    ],
  ]) {
    test(`${command} names the version it answers as`, async () => {
      const result = await new Bash().exec(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.split("\n")[0]).toBe(line);
    });
  }

  for (const flag of ["--version", "-V", "-sV"]) {
    test(`curl ${flag} answers without a URL`, async () => {
      const result = await new Bash({ network: full }).exec(`curl ${flag}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith(
        "curl 8.21.0 (just-bash, compatible)\n",
      );
    });
  }
});
