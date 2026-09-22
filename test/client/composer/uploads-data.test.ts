// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  askedOf,
  deleteUpload,
  forgetUpload,
  loadUploads,
  stagedOf,
  takeStamp,
} from "../../../src/client/data/uploads.ts";
import type { StagedUpload } from "../../../src/shared/contracts/knowledge.ts";

const LIMITS = {
  itemBytes: 1,
  fileBytes: 1,
  uploadBytes: 1,
  uploadFiles: 1,
  perMessage: 1,
  stagedItems: 1,
};

const item = (id: string, attempt: string): StagedUpload => ({
  id,
  attempt,
  name: `${id}.md`,
  archive: false,
  folder: "",
  files: 1,
  bytes: 1,
  saved: [`${id}.md`],
  skipped: [],
  skippedTotal: 0,
  renamed: 0,
  expiresAt: 1,
});

const realFetch = globalThis.fetch;
let calls: { method: string; url: string }[];
let gates: ((items: StagedUpload[]) => void)[];
let user = 0;

beforeEach(() => {
  calls = [];
  gates = [];
  user++;
  me.value = {
    id: `uploads-u${user}`,
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method !== "GET")
      return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise<Response>((resolve) => {
      gates.push((items) => resolve(Response.json({ items, limits: LIMITS })));
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

const tick = () => new Promise((done) => setTimeout(done, 0));

describe("the staged list", () => {
  test.serial("loads asked for at once share one request", async () => {
    const all = Promise.all([
      loadUploads("p1"),
      loadUploads("p1"),
      loadUploads("p1"),
    ]);
    await tick();
    expect(calls).toHaveLength(1);
    gates[0]?.([item("up1", "t1")]);
    await all;
    expect(calls).toHaveLength(1);
    expect(stagedOf("p1")?.items.map((row) => row.id)).toEqual(["up1"]);
    expect(await all).toEqual([true, true, true]);
  });

  test.serial(
    "a list is as fresh as the moment it was asked for, not the moment it answered",
    async () => {
      const load = loadUploads("p1");
      await tick();
      const unknown = takeStamp();
      gates[0]?.([]);
      await load;
      // it answered after the stamp, but was asked for before it
      expect(askedOf("p1")).toBeLessThan(unknown);
      const again = loadUploads("p1");
      await tick();
      gates[1]?.([]);
      await again;
      expect(askedOf("p1")).toBeGreaterThan(unknown);
    },
  );

  test.serial("a load that fails says so and keeps what is held", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("{}", { status: 500 }),
      )) as unknown as typeof fetch;
    expect(await loadUploads("p1")).toBe(false);
    expect(stagedOf("p1")).toBeNull();
  });

  test.serial(
    "a delete that lands while a list loads makes it ask once more, never bringing the row back",
    async () => {
      const first = loadUploads("p1");
      await tick();
      gates[0]?.([item("up1", "t1")]);
      await first;
      const second = loadUploads("p1");
      await tick();
      await deleteUpload("p1", "up1");
      // the list in flight still holds the row
      gates[1]?.([item("up1", "t1")]);
      await tick();
      gates[2]?.([]);
      await second;
      expect(stagedOf("p1")?.items).toEqual([]);
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(3);
    },
  );

  test.serial(
    "a forgotten attempt a list shows is deleted and not kept",
    async () => {
      forgetUpload("t9");
      const load = loadUploads("p1");
      await tick();
      gates[0]?.([item("up9", "t9"), item("up1", "t1")]);
      await load;
      await tick();
      expect(stagedOf("p1")?.items.map((row) => row.id)).toEqual(["up1"]);
      expect(calls.at(-1)).toEqual({
        method: "DELETE",
        url: "/api/projects/p1/uploads/up9",
      });
    },
  );
});
