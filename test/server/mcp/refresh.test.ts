// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Clock } from "../../../src/server/lib/clock.ts";
import type { DiscoveryResult } from "../../../src/server/mcp/discover.ts";
import { mcpArea } from "../../../src/server/mcp/index.ts";
import { RefreshCoordinator } from "../../../src/server/mcp/refresh.ts";
import { routes } from "../../../src/server/mcp/routes.ts";
import { McpServerStore } from "../../../src/server/mcp/store.ts";
import type { CreateMcpRequest } from "../../../src/shared/api/mcp.ts";
import { memoryDb } from "../../helpers/db.ts";
import { fixture, mcpFetch } from "./fake.ts";

const fields = (name = "cluster"): CreateMcpRequest => ({
  name,
  url: `https://${name}.test/mcp`,
  keyName: null,
  read: true,
  write: true,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: ["get_*"],
  writePatterns: [],
  excludedPatterns: [],
});

const found = (at: number, fingerprint = "old"): DiscoveryResult => ({
  serverName: "server",
  serverVersion: "1",
  protocolEra: "modern",
  protocolVersion: "2026-07-28",
  instructions: "Use it.",
  fingerprint,
  checkedAt: at,
  tools: [
    {
      name: "get_status",
      description: "Get status.",
      inputSchema: { type: "object", properties: {} },
      schemaJson: '{"type":"object","properties":{}}',
      unusable: null,
    },
  ],
});

function fakeClock(start = 1_000_000): {
  clock: Clock;
  advance(ms: number): void;
} {
  let now = start;
  const sleepers = new Set<{ at: number; resolve: () => void }>();
  const clock = Object.assign(() => now, {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.add({ at: now + ms, resolve });
      }),
  });
  return {
    clock,
    advance(ms) {
      now += ms;
      for (const sleeper of [...sleepers]) {
        if (sleeper.at > now) continue;
        sleepers.delete(sleeper);
        sleeper.resolve();
      }
    },
  };
}

const settle = () => Bun.sleep(10);

describe("MCP refresh coordinator", () => {
  test("coalesces drift refreshes and honors the five minute hold", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const area = mcpArea({
      db,
      fetcher: fake.fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    for (let index = 0; index < 10; index++) {
      area.refreshSoon(row.id, `changed-${index}`);
    }
    await settle();
    expect(
      fake.requests.filter((request) => request.method === "server/discover"),
    ).toHaveLength(1);
    area.refreshSoon(row.id, "changed-again");
    await settle();
    expect(
      fake.requests.filter((request) => request.method === "server/discover"),
    ).toHaveLength(1);
    time.advance(5 * 60 * 1_000);
    area.refreshSoon(row.id, "changed-later");
    await settle();
    expect(
      fake.requests.filter((request) => request.method === "server/discover"),
    ).toHaveLength(2);
    await area.close();
    db.close();
  });

  test("does nothing when the observed fingerprint is current", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const area = mcpArea({
      db,
      fetcher: fake.fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.refreshSoon(row.id, "old");
    await settle();
    expect(fake.requests).toHaveLength(0);
    await area.close();
    db.close();
  });

  test("the hourly loop refreshes stale rows after its wait", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const area = mcpArea({
      db,
      fetcher: fake.fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    area.store.create(fields(), found(time.clock() - 60 * 60 * 1_000 - 1));
    area.start();
    time.advance(60 * 60 * 1_000);
    await settle();
    expect(
      fake.requests.filter((request) => request.method === "server/discover"),
    ).toHaveLength(1);
    await area.close();
    db.close();
  });

  test("holds for five minutes after a failed automatic discovery", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("failed", { status: 500 });
    }) as unknown as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.refreshSoon(row.id, "changed-once");
    await settle();
    expect(calls).toBe(1);
    expect(area.store.byId(row.id)!.refreshError).not.toBeNull();
    area.refreshSoon(row.id, "changed-twice");
    await settle();
    expect(calls).toBe(1);
    time.advance(5 * 60 * 1_000 - 1);
    area.refreshSoon(row.id, "changed-thrice");
    await settle();
    expect(calls).toBe(1);
    time.advance(1);
    area.refreshSoon(row.id, "changed-later");
    await settle();
    expect(calls).toBe(2);
    await area.close();
    db.close();
  });

  test("a pass refreshes each stale server once, in order, then waits an hour", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const discovered: string[] = [];
    let inFlight = 0;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = (async (input: string | URL | Request) => {
      inFlight++;
      expect(inFlight).toBe(1);
      const url = input instanceof Request ? input.url : String(input);
      discovered.push(new URL(url).host);
      await gate;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      inFlight--;
      return new Response("failed", { status: 500 });
    }) as unknown as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const stale = time.clock() - 60 * 60 * 1_000 - 10;
    area.store.create(fields("alpha"), found(stale));
    area.store.create(fields("bravo"), found(stale + 1));
    area.store.create(fields("charlie"), found(stale + 2));
    area.start();
    time.advance(60 * 60 * 1_000);
    await settle();
    // one at a time: only the first is in flight until released
    expect(discovered).toEqual(["alpha.test"]);
    release();
    await settle();
    expect(discovered).toEqual(["alpha.test", "bravo.test"]);
    release();
    await settle();
    expect(discovered).toEqual(["alpha.test", "bravo.test", "charlie.test"]);
    release();
    await settle();
    // the pass is done; a short wait starts no new discovery
    time.advance(60 * 60 * 1_000 - 1);
    await settle();
    expect(discovered).toHaveLength(3);
    await area.close();
    db.close();
  });

  test("close ends a discovery the pass launched, writing no failure", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let started = false;
    let ended = false;
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      started = true;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          ended = true;
          reject(new Error("aborted"));
        });
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(
      fields(),
      found(time.clock() - 60 * 60 * 1_000 - 1),
    );
    area.start();
    time.advance(60 * 60 * 1_000);
    await settle();
    expect(started).toBeTrue();
    await area.close();
    expect(ended).toBeTrue();
    expect(area.store.byId(row.id)!.refreshError).toBeNull();
    db.close();
  });

  test("close aborts and awaits a running discovery without failure", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let started = false;
    let ended = false;
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      started = true;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          ended = true;
          reject(new Error("aborted"));
        });
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.refreshSoon(row.id, "new");
    await settle();
    expect(started).toBeTrue();
    await area.close();
    expect(ended).toBeTrue();
    expect(area.store.byId(row.id)!.refreshError).toBeNull();
    db.close();
  });

  test("close awaits a route discovery and prevents its final write", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found(time.clock()));
    let begin!: () => void;
    let finish!: (value: DiscoveryResult) => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const discover = () =>
      new Promise<DiscoveryResult>((resolve) => {
        finish = resolve;
        begin();
      });
    const coordinator = new RefreshCoordinator({
      store,
      clock: time.clock,
      log: () => {},
      discover,
    });
    const route = routes({
      store,
      coordinator,
      clock: time.clock,
      log: () => {},
      hasSecret: () => false,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      render: (text) => text,
      discover,
    }).find(
      (item) => item.method === "POST" && item.path === "/api/mcp/:id/refresh",
    )!;
    const pending = Promise.resolve(
      route.handle(
        new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
          method: "POST",
        }),
        routeContext(row.id),
      ),
    );
    await started;
    const closing = coordinator.close();
    finish(found(time.clock() + 1, "new"));
    await closing;
    await expect(pending).rejects.toMatchObject({ status: 502 });
    const kept = store.byId(row.id)!;
    expect(kept.checkedAt).toBe(row.checkedAt);
    expect(kept.fingerprint).toBe(row.fingerprint);
    expect(kept.refreshError).toBeNull();
    db.close();
  });

  test("close ends the pass wait and later discovery routes get 503", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const area = mcpArea({
      db,
      fetcher: fake.fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    area.start();
    await area.close();
    const route = area.routes.find(
      (item) => item.method === "POST" && item.path === "/api/mcp",
    )!;
    const request = new Request("https://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields()),
    });
    await expect(
      route.handle(request, {
        principal: {
          userId: "admin",
          username: "admin",
          fullName: "Admin",
          role: "admin",
          mustChangePassword: false,
          loginId: "login",
        },
        params: {},
        url: new URL(request.url),
        address: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ status: 503 });
    db.close();
  });

  test("two areas do not share refresh state", async () => {
    const recorded = await fixture();
    const firstDb = memoryDb();
    const secondDb = memoryDb();
    const firstFake = mcpFetch({ recorded });
    const secondFake = mcpFetch({ recorded });
    const time = fakeClock();
    const make = (db: typeof firstDb, fetcher: typeof fetch) =>
      mcpArea({
        db,
        fetcher,
        secret: () => null,
        keys: () => [],
        callTimeoutMs: () => 20_000,
        clock: time.clock,
        log: () => {},
        version: "test",
        render: (text) => text,
      });
    const first = make(firstDb, firstFake.fetcher);
    const second = make(secondDb, secondFake.fetcher);
    const firstRow = first.store.create(fields(), found(time.clock()));
    const secondRow = second.store.create(fields(), found(time.clock()));
    first.refreshSoon(firstRow.id, "new");
    second.refreshSoon(secondRow.id, "new");
    await settle();
    expect(firstFake.requests).not.toHaveLength(0);
    expect(secondFake.requests).not.toHaveLength(0);
    await Promise.all([first.close(), second.close()]);
    firstDb.close();
    secondDb.close();
  });
});

function routeContext(id: string) {
  return {
    principal: {
      userId: "admin",
      username: "admin",
      fullName: "Admin",
      role: "admin" as const,
      mustChangePassword: false,
      loginId: "login",
    },
    params: { id },
    url: new URL(`https://app.test/api/mcp/${id}`),
    address: "127.0.0.1",
  };
}

describe("MCP refresh routes", () => {
  test("explicit refresh is 409 while an automatic refresh runs", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let started = false;
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      started = true;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("stop")),
        );
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.refreshSoon(row.id, "new");
    await settle();
    expect(started).toBeTrue();
    const route = area.routes.find(
      (item) => item.method === "POST" && item.path === "/api/mcp/:id/refresh",
    )!;
    await expect(
      route.handle(
        new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
          method: "POST",
        }),
        routeContext(row.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await area.close();
    db.close();
  });

  test("a second explicit refresh is 409 while the first still runs", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      began();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("stop")),
        );
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    const refresh = area.routes.find(
      (item) => item.method === "POST" && item.path === "/api/mcp/:id/refresh",
    )!;
    const first = refresh.handle(
      new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
        method: "POST",
      }),
      routeContext(row.id),
    );
    await started;
    await expect(
      refresh.handle(
        new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
          method: "POST",
        }),
        routeContext(row.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await area.close();
    await expect(first).rejects.toBeDefined();
    db.close();
  });

  test("an endpoint patch is 409 while a discovery for the server runs", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      began();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("stop")),
        );
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    const refresh = area.routes.find(
      (item) => item.method === "POST" && item.path === "/api/mcp/:id/refresh",
    )!;
    const running = refresh.handle(
      new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
        method: "POST",
      }),
      routeContext(row.id),
    );
    await started;
    const patch = area.routes.find(
      (item) => item.method === "PATCH" && item.path === "/api/mcp/:id",
    )!;
    await expect(
      patch.handle(
        new Request(`https://app.test/api/mcp/${row.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://moved.test/mcp" }),
        }),
        routeContext(row.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(area.store.byId(row.id)!.url).toBe(row.url);
    await area.close();
    await expect(running).rejects.toBeDefined();
    db.close();
  });

  test("delete aborts discovery before removing the server", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let ended = false;
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          ended = true;
          reject(new Error("stop"));
        });
      })) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.refreshSoon(row.id, "new");
    await settle();
    const route = area.routes.find(
      (item) => item.method === "DELETE" && item.path === "/api/mcp/:id",
    )!;
    const response = await route.handle(
      new Request(`https://app.test/api/mcp/${row.id}`, { method: "DELETE" }),
      routeContext(row.id),
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(204);
    await settle();
    expect(ended).toBeTrue();
    expect(area.store.byId(row.id)).toBeNull();
    await area.close();
    db.close();
  });

  test("delete makes an in-flight route refresh end as 404", async () => {
    const db = memoryDb();
    const time = fakeClock();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const fetcher = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      began();
      return new Promise<Response>((_resolve, reject) => {
        const stop = () => reject(init?.signal?.reason);
        if (init?.signal?.aborted) stop();
        else init?.signal?.addEventListener("abort", stop, { once: true });
      });
    }) as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    const refresh = area.routes.find(
      (item) => item.method === "POST" && item.path === "/api/mcp/:id/refresh",
    )!;
    const pending = refresh.handle(
      new Request(`https://app.test/api/mcp/${row.id}/refresh`, {
        method: "POST",
      }),
      routeContext(row.id),
    );
    await started;
    const remove = area.routes.find(
      (item) => item.method === "DELETE" && item.path === "/api/mcp/:id",
    )!;
    const response = await remove.handle(
      new Request(`https://app.test/api/mcp/${row.id}`, { method: "DELETE" }),
      routeContext(row.id),
    );
    expect((response as Response).status).toBe(204);
    await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(area.store.byId(row.id)).toBeNull();
    await area.close();
    db.close();
  });

  test("a failed endpoint candidate leaves failure columns untouched", async () => {
    const db = memoryDb();
    const time = fakeClock();
    const fetcher = (async () =>
      new Response("failed", { status: 500 })) as unknown as typeof fetch;
    const area = mcpArea({
      db,
      fetcher,
      secret: () => null,
      keys: () => [],
      callTimeoutMs: () => 20_000,
      clock: time.clock,
      log: () => {},
      version: "test",
      render: (text) => text,
    });
    const row = area.store.create(fields(), found(time.clock()));
    area.store.recordFailure(row.id, "old failure", time.clock() - 1);
    const route = area.routes.find(
      (item) => item.method === "PATCH" && item.path === "/api/mcp/:id",
    )!;
    await expect(
      route.handle(
        new Request(`https://app.test/api/mcp/${row.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://moved.test/mcp" }),
        }),
        routeContext(row.id),
      ),
    ).rejects.toMatchObject({ status: 502 });
    const unchanged = area.store.byId(row.id)!;
    expect(unchanged.url).toBe(row.url);
    expect(unchanged.refreshError).toBe("old failure");
    expect(unchanged.refreshFailedAt).toBe(time.clock() - 1);
    await area.close();
    db.close();
  });
});
