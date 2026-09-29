// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The real worker over a file database: the app writes on its
// connection, the worker reads beside it, and the answer names the file.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { overviewArea } from "../../../src/server/overview/index.ts";
import { workerScanner } from "../../../src/server/overview/worker.ts";
import type {
  OverviewResponse,
  StorageResponse,
  UsageResponse,
} from "../../../src/shared/api/admin.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import { fileDb } from "../../helpers/db.ts";

const IDLE = { chats: 0, runs: 0, scheduled: 0, projectsFull: 0 };
const WORKER = new URL(
  "../../../src/server/overview/scan.worker.ts",
  import.meta.url,
);

describe("the scan worker", () => {
  test.each(["storage", "overview", "usage"])(
    "answers %s from a worker's own file connection",
    async (page) => {
      const file = fileDb();
      let app: Awaited<ReturnType<typeof testApp>> | undefined;
      try {
        app = await testApp({ db: file.db });
        const admin = app.client();
        await admin.login("admin", "hunter2-test");
        const month = new Date(app.now.value).toISOString().slice(0, 7);
        const query = page === "usage" ? `&month=${month}` : "";
        const res = await admin.call(
          "GET",
          `/api/admin/${page}?tz=UTC${query}`,
        );
        expect(res.status).toBe(200);
        if (page === "storage") {
          const body: StorageResponse = await res.json();
          expect(body.file.name).toBe(basename(file.path));
          expect(body.file.bytes).toBeGreaterThan(0);
          expect(body.file.journalMode).toBe("wal");
          expect(body.file.walBytes).toBeGreaterThan(0);
          const config = body.areas.find((area) => area.key === "config")!;
          expect(
            config.tables.find((table) => table.name === "users")?.rows,
          ).toBe(1);
        } else if (page === "overview") {
          const body: OverviewResponse = await res.json();
          expect(body.days).toHaveLength(30);
          expect(body.instance.users).toBe(1);
          expect(body.instance.databaseBytes).toBeGreaterThan(0);
          expect(body.range).toBe("30d");
        } else {
          const body: UsageResponse = await res.json();
          expect(body.month).toBe(month);
          expect(body.days.length).toBeGreaterThan(0);
          expect(body.since).toBeNull();
          expect(body.by).toEqual({ projects: [], agents: [], models: [] });
        }
      } finally {
        await app?.shutdown();
        file.cleanup();
      }
    },
  );

  test("a file that cannot be opened fails the scan without its path", async () => {
    const path = join(tmpdir(), "1ctx-missing", "none.sqlite");
    const scanner = workerScanner(path, WORKER);
    await expect(scanner.scan({ now: 0, since: 0 })).rejects.toThrow();
    await expect(scanner.scan({ now: 0, since: 0 })).rejects.not.toThrow(
      new RegExp(path.replaceAll("\\", "\\\\")),
    );
  });

  test("a failed scan is a 500 and a warning", async () => {
    const { events, logFactory } = collectLogs();
    const app = await testApp({ logFactory });
    const area = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: logFactory("overview"),
      limits: { current: () => DEFAULT_LIMITS },
      version: "v0.0.0-test",
      startedAt: 0,
      running: () => IDLE,
      online: () => 0,
      automations: () => ({ total: 0, waiting: 0 }),
      queue: () => ({ queued: 0, notSent: 0, oldestQueuedAt: null }),
      attention: () => ({
        providers: [],
        mcp: [],
        skills: [],
        credentials: [],
        search: { provider: null, hasKey: false },
      }),
      worker: WORKER,
      scanner: {
        scan: () => Promise.reject(new Error("disk gone")),
        range: () => Promise.reject(new Error("disk gone")),
        month: () => Promise.reject(new Error("disk gone")),
        close() {},
      },
    });
    await expect(area.storage("UTC")).rejects.toThrow("disk gone");
    const warning = events.find((e) => e.msg === "storage scan failed");
    expect(warning).toMatchObject({
      area: "overview",
      level: "warn",
      fields: { error: "disk gone" },
    });
    await app.shutdown();
  });

  test("a scan past its deadline is ended and refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "1ctx-stuck-"));
    try {
      const stuck = join(dir, "stuck.worker.ts");
      writeFileSync(stuck, "self.onmessage = () => {};\n");
      const scanner = workerScanner("unused.sqlite", pathToFileURL(stuck), 50);
      await expect(scanner.scan({ now: 0, since: 0 })).rejects.toThrow(
        "scan timed out",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close ends a scan in flight", async () => {
    const file = fileDb();
    try {
      const scanner = workerScanner(file.path, WORKER);
      const pending = scanner.scan({ now: 0, since: 0 });
      scanner.close();
      await expect(pending).rejects.toThrow();
    } finally {
      file.cleanup();
    }
  });
});
