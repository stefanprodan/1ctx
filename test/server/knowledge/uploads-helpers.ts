// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import {
  DEFAULT_LIMITS,
  type Limits,
} from "../../../src/server/limits/index.ts";
import { serve } from "../../../src/server/web/serve.ts";
import type {
  StagedUpload,
  StagedUploads,
} from "../../../src/shared/contracts/knowledge.ts";
import page from "../../fixtures/body.html";
import { hashPassword, ORIGIN, testApp } from "../../helpers/app.ts";

export type UploadOptions = {
  body?: BodyInit;
  query?: string;
  name?: string;
  attempt?: string;
  cookie?: string | null;
  projectId?: string;
  origin?: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export async function setupUploads(
  transport: "composed" | "listener" = "composed",
) {
  const app = await testApp();
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const owner = app.createUser({
    username: "writer",
    fullName: "Writer",
    email: "writer@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const client = app.client();
  expect((await client.login("writer", "password-test")).status).toBe(200);
  const projectId = app.projects.personal(owner.id)!.id;
  const adminProjectId = app.projects.personal(
    app.users.byUsername("admin")!.id,
  )!.id;
  const listener =
    transport === "listener"
      ? serve({
          hostname: "127.0.0.1",
          port: 0,
          page,
          development: false,
          trustProxy: false,
          socket: app.socket,
          handle: app.handle,
        })
      : null;
  const origin = listener?.server.url.origin ?? ORIGIN;
  const request = (
    method: string,
    suffix = "",
    options: UploadOptions = {},
  ) => {
    const headers = new Headers(options.headers);
    headers.set("origin", options.origin ?? origin);
    headers.set("content-type", "application/octet-stream");
    const cookie =
      options.cookie === undefined ? client.cookie : options.cookie;
    if (cookie) headers.set("cookie", cookie);
    if (listener) headers.set("connection", "close");
    return new Request(
      `${origin}/api/projects/${options.projectId ?? projectId}/uploads${suffix}`,
      {
        method,
        headers,
        ...(method === "POST" ? { body: options.body ?? "hello\n" } : {}),
        signal: options.signal,
      },
    );
  };
  const send = async (req: Request) => {
    if (listener) return fetch(req);
    const response = await app.handle(req, "127.0.0.1");
    expect(response).toBeInstanceOf(Response);
    return response!;
  };
  const call = (method: string, suffix = "", options: UploadOptions = {}) =>
    send(request(method, suffix, options));
  const query = (options: UploadOptions = {}) =>
    options.query ??
    new URLSearchParams({
      name: options.name ?? "readme.md",
      attempt: options.attempt ?? crypto.randomUUID(),
    }).toString();
  return {
    app,
    admin,
    client,
    owner,
    projectId,
    adminProjectId,
    origin,
    request,
    send,
    call,
    upload: (options: UploadOptions = {}) =>
      call("POST", `?${query(options)}`, options),
    async list(options: UploadOptions = {}): Promise<StagedUploads> {
      const response = await call("GET", "", options);
      expect(response.status).toBe(200);
      return response.json();
    },
    async limits(overrides: Partial<Limits>) {
      const response = await admin.call("PUT", "/api/limits", {
        body: { values: { ...DEFAULT_LIMITS, ...overrides } },
      });
      expect(response.status).toBe(200);
    },
    async close() {
      await listener?.stop();
      await app.shutdown();
      app.db.close();
    },
  };
}

export async function staged(response: Response): Promise<StagedUpload> {
  expect(response.status).toBe(200);
  return response.json();
}

export const archiveFixture = (name: string) =>
  Bun.file(new URL(`../../fixtures/archives/${name}`, import.meta.url)).bytes();

export function stalledBody(prefix = "") {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<unknown>();
  const cleanup = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
      },
      pull() {
        started.resolve();
      },
      cancel(reason) {
        cancelled.resolve(reason);
        return cleanup.promise;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    started: started.promise,
    cancelled: cancelled.promise,
    cleanup: () => cleanup.resolve(),
    finish(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}
