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
import type { StorageResponse } from "../../../src/shared/api/admin.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import { fileDb } from "../../helpers/db.ts";

const WORKER = new URL(
  "../../../src/server/overview/scan.worker.ts",
  import.meta.url,
);

describe("the scan worker", () => {
  test("scans a file database from its own connection", async () => {
    const file = fileDb();
    try {
      const app = await testApp({ db: file.db });
      const admin = app.client();
      await admin.login("admin", "hunter2-test");
      const res = await admin.call("GET", "/api/admin/storage?tz=UTC");
      expect(res.status).toBe(200);
      const body: StorageResponse = await res.json();
      expect(body.file.name).toBe(basename(file.path));
      expect(body.file.bytes).toBeGreaterThan(0);
      expect(body.file.journalMode).toBe("wal");
      expect(body.file.walBytes).toBeGreaterThan(0);
      const config = body.areas.find((area) => area.key === "config")!;
      expect(config.tables.find((table) => table.name === "users")?.rows).toBe(
        1,
      );
      await app.shutdown();
    } finally {
      file.cleanup();
    }
  });

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
      worker: WORKER,
      scanner: {
        scan: () => Promise.reject(new Error("disk gone")),
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
