// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type { CommandCaps } from "../../../src/server/knowledge/mount.ts";
import { callCaps, run, setup } from "./helpers.ts";

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return {
    host: `127.0.0.1:${server.port}`,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const all = {
  ...callCaps,
  web: { mode: "all", domains: [] },
  fetchDeadlineMs: 2000,
  fetchBodyBytes: 4096,
} satisfies CommandCaps;

function listed(host: string): CommandCaps {
  // A raw snapshot keeps the fixture on its ephemeral loopback port.
  // Admin domain parsing permits only default ports.
  return { ...all, web: { mode: "listed", domains: [host] } };
}

test("without a network snapshot curl and wget remain unavailable", async () => {
  const s = setup();
  try {
    for (const command of ["curl", "wget"]) {
      const result = await run(s, `${command} http://127.0.0.1/`);
      expect(result.error).toBe(true);
      expect(result.content).toContain(`${command}: command not found`);
      expect(result.content).toContain("exit 127");
    }
  } finally {
    s.db.close();
  }
});

async function fullAccess(mode: "all" | "listed" = "all") {
  const s = setup();
  const received: { method: string; body: string }[] = [];
  const server = serve(async (req) => {
    const body = await req.text();
    received.push({ method: req.method, body });
    return new Response(`${req.method} ${body}`.trim());
  });
  try {
    const caps = mode === "all" ? all : listed(server.host);
    const get = await run(s, `curl -sS ${server.url}/`, caps);
    expect(get.error).toBe(false);
    expect(get.content).toContain("GET");
    const post = await run(
      s,
      `curl -sS -X POST -d payload ${server.url}/`,
      caps,
    );
    expect(post.error).toBe(false);
    expect(post.content).toContain("POST payload");
    expect(received).toEqual([
      { method: "GET", body: "" },
      { method: "POST", body: "payload" },
    ]);
    const wget = await run(s, `wget ${server.url}/`, caps);
    expect(wget.content).toContain("wget: command not found");
    expect(received).toHaveLength(2);
  } finally {
    server.stop();
    s.db.close();
  }
}

test("all access reaches loopback with GET and POST but never adds wget", () =>
  fullAccess());

test.serial("production does not turn private-range blocking on", async () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    await fullAccess();
    await fullAccess("listed");
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test("listed access reaches its exact origin with all seven methods", async () => {
  const s = setup();
  const methods: string[] = [];
  const server = serve((req) => {
    methods.push(req.method);
    return new Response(req.method);
  });
  try {
    for (const method of [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
    ]) {
      const result = await run(
        s,
        `curl -sS ${method === "HEAD" ? "-I" : `-X ${method}`} ${server.url}/`,
        listed(server.host),
      );
      expect(result.error, `${method}: ${result.content}`).toBe(false);
    }
    expect(methods).toEqual([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
    ]);
    const refused = await run(
      s,
      `echo kept > /knowledge/method.txt; echo scratch > /tmp/method; curl -sS -X PROPFIND ${server.url}/`,
      listed(server.host),
    );
    expect(refused.error).toBe(true);
    expect(refused.content).toContain("PROPFIND");
    expect(refused.content).toContain("wrote method.txt");
    expect(
      s.area.read(s.projectId, s.area.list(s.projectId).files[0]!.id).text,
    ).toBe("kept\n");
    expect(s.area.scratch.read(s.session.id).entries[0]!.path).toBe("method");
    expect(methods).toHaveLength(7);
  } finally {
    server.stop();
    s.db.close();
  }
});

test("a listed origin refuses other origins and redirects without discarding writes", async () => {
  const s = setup();
  let refusedHits = 0;
  const other = serve(() => {
    refusedHits++;
    return new Response("must not reach");
  });
  const server = serve(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `${other.url}/target` },
      }),
  );
  try {
    for (const [name, command] of [
      ["direct", `curl -sS ${other.url}/`],
      ["redirect", `curl -sSL ${server.url}/`],
    ]) {
      const result = await run(
        s,
        `echo ${name} > /knowledge/${name}.txt; echo ${name} > /tmp/${name}; ${command}`,
        listed(server.host),
      );
      expect(result.error).toBe(true);
      expect(result.content).toContain("allow-list");
      expect(result.content).toContain(`wrote ${name}.txt`);
    }
    expect(s.area.list(s.projectId).files.map((file) => file.name)).toEqual([
      "direct.txt",
      "redirect.txt",
    ]);
    expect(
      s.area.scratch.read(s.session.id).entries.map((file) => file.path),
    ).toEqual(["direct", "redirect"]);
    expect(refusedHits).toBe(0);
  } finally {
    server.stop();
    other.stop();
    s.db.close();
  }
});

test("network downloads keep bytes in scratch and reject non-text knowledge atomically", async () => {
  const s = setup();
  const bytes = new Uint8Array([0, 255, 4, 1]);
  const server = serve(() => new Response(bytes));
  try {
    const scratch = await run(
      s,
      `curl -sS -o /tmp/download ${server.url}/`,
      all,
    );
    expect(scratch.error, scratch.content).toBe(false);
    expect(s.area.scratch.read(s.session.id).entries[0]!.data).toEqual(bytes);
    const revision = s.area.scratch.read(s.session.id).revision;
    const bad = await run(
      s,
      `echo unsaved > /tmp/new; curl -sS -o /knowledge/download ${server.url}/`,
      all,
    );
    expect(bad.error).toBe(true);
    expect(s.area.list(s.projectId).files).toEqual([]);
    expect(s.area.scratch.read(s.session.id).revision).toBe(revision);
  } finally {
    server.stop();
    s.db.close();
  }
});

test("the network response cap comes from the command's caps", async () => {
  const s = setup();
  const server = serve(
    () =>
      new Response("a".repeat(100), {
        headers: { "content-length": "100" },
      }),
  );
  try {
    const result = await run(s, `curl -sS ${server.url}/`, {
      ...all,
      web: { mode: "all", domains: [] },
      fetchDeadlineMs: 2000,
      fetchBodyBytes: 16,
    });
    expect(result.error).toBe(true);
    expect(result.content).toContain("Response body too large (max: 16 bytes)");
  } finally {
    server.stop();
    s.db.close();
  }
});
