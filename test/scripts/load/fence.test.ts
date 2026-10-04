// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Res, Who } from "../../../scripts/load/driver/api.ts";
import {
  assertFenced,
  type Caller,
  fenceWeb,
} from "../../../scripts/load/driver/directory.ts";
import { checkServer, checkTarget } from "../../../scripts/load/kind.ts";
import { type TestClient, testApp } from "../../helpers/app.ts";

const MODEL = "http://127.0.0.1:1241/v1";
const MCP = "http://127.0.0.1:1250/";

// the driver's calls answered by the app in process
function caller(client: TestClient): Caller {
  const call = async <T>(
    _who: Who | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Res<T>> => {
    const res = await client.call(method, path, { body });
    const text = await res.text();
    const parsed = text === "" ? null : JSON.parse(text);
    return {
      status: res.status,
      body: parsed as T,
      ms: 0,
      error: res.ok ? "" : (parsed?.error ?? text),
    };
  };
  return {
    call,
    async must<T>(who: Who, method: string, path: string, body?: unknown) {
      const r = await call<T>(who, method, path, body);
      if (r.status < 200 || r.status > 299) {
        throw new Error(`${method} ${path}: ${r.status} ${r.error}`);
      }
      return r.body;
    },
  } as Caller;
}

const admin: Who = { user: "admin", cookie: "", id: "", role: "admin" };

describe("the driver's fence", () => {
  test("refuses an instance with web access on, then turns it off", async () => {
    const app = await testApp();
    try {
      const client = app.client();
      await client.login("admin", "hunter2-test");
      const api = caller(client);
      await api.must(admin, "PATCH", "/api/tools/web", { mode: "all" });
      await expect(assertFenced(api, admin, MODEL, MCP)).rejects.toThrow(
        "web access all",
      );
      await fenceWeb(api, admin);
      await assertFenced(api, admin, MODEL, MCP);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});

describe("the kind target", () => {
  test("runs only on a kind context and a 1ctx namespace", () => {
    expect(() => checkTarget("kind-flux", "1ctx-load")).not.toThrow();
    expect(() => checkTarget("prod-cluster", "1ctx-load")).toThrow("context");
    expect(() => checkTarget("kind-flux", "default")).toThrow("namespace");
  });

  test("runs only on a cluster served from loopback", () => {
    for (const server of [
      "https://127.0.0.1:56011",
      "https://localhost:6443",
      "https://[::1]:6443",
    ]) {
      expect(() => checkServer("kind-flux", server)).not.toThrow();
    }
    for (const server of [
      "https://10.0.0.5:6443",
      "https://k8s.example:443",
      "",
    ]) {
      expect(() => checkServer("kind-flux", server)).toThrow("not on loopback");
    }
  });
});
