// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  ARCHIVE_DEADLINE_MS,
  KNOWLEDGE_COMMANDS_IN_FLIGHT,
  MAX_ARCHIVE_UPLOAD,
} from "../../../src/server/knowledge/limits.ts";
import { acquire } from "../../../src/server/knowledge/queue.ts";
import { serve } from "../../../src/server/web/serve.ts";
import type { KnowledgeUploadResult } from "../../../src/shared/contracts/knowledge.ts";
import page from "../../fixtures/body.html";
import { hashPassword, ORIGIN, testApp } from "../../helpers/app.ts";

type Transport = "composed" | "listener";
type Upload = {
  body?: BodyInit;
  name?: string | null;
  folder?: string;
  projectId?: string;
  cookie?: string | null;
  origin?: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

async function setup(transport: Transport = "composed") {
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
  const request = (options: Upload = {}) => {
    const query = new URLSearchParams({ folder: options.folder ?? "" });
    if (options.name !== null) query.set("name", options.name ?? "readme.md");
    const headers = new Headers(options.headers);
    headers.set("origin", options.origin ?? origin);
    headers.set("content-type", "application/octet-stream");
    const cookie =
      options.cookie === undefined ? client.cookie : options.cookie;
    if (cookie) headers.set("cookie", cookie);
    if (listener) headers.set("connection", "close");
    return new Request(
      `${origin}/api/projects/${options.projectId ?? projectId}/knowledge/upload?${query}`,
      {
        method: "POST",
        headers,
        body: options.body ?? "hello\n",
        signal: options.signal,
      },
    );
  };
  const send = async (req: Request): Promise<Response> => {
    if (listener) return fetch(req);
    const response = await app.handle(req, "127.0.0.1");
    expect(response).toBeInstanceOf(Response);
    return response!;
  };
  return {
    app,
    admin,
    client,
    owner,
    projectId,
    adminProjectId,
    request,
    send,
    upload: (options?: Upload) => send(request(options)),
    async close() {
      await listener?.stop();
      await app.shutdown();
      app.db.close();
    },
  };
}

async function result(response: Response): Promise<KnowledgeUploadResult> {
  expect(response.status).toBe(200);
  return response.json();
}

function stalledBody() {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<unknown>();
  const cleanup = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
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

async function holdSlots(count = KNOWLEDGE_COMMANDS_IN_FLIGHT) {
  const slots: (() => void)[] = [];
  for (let i = 0; i < count; i++) {
    slots.push(await acquire(new AbortController().signal));
  }
  return slots;
}

for (const transport of ["composed", "listener"] as const) {
  test.serial(
    `${transport}: upload enforces login, project privacy and same origin`,
    async () => {
      const s = await setup(transport);
      try {
        const anonymous = await s.upload({ cookie: null });
        expect(anonymous.status).toBe(401);
        expect(await anonymous.json()).toEqual({ error: "sign in" });
        for (const options of [
          { projectId: s.adminProjectId },
          { cookie: s.admin.cookie },
          { projectId: "missing-project" },
        ]) {
          const response = await s.upload(options);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "no such project" });
        }
        const crossOrigin = await s.upload({
          origin: "https://elsewhere.test",
        });
        expect(crossOrigin.status).toBe(403);
        expect(await crossOrigin.json()).toEqual({
          error: "cross-origin request",
        });
        expect(s.app.knowledge.list(s.projectId).files).toEqual([]);
        expect(s.app.knowledge.list(s.adminProjectId).files).toEqual([]);
      } finally {
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: text, tar and zip bytes save through sequential uploads`,
    async () => {
      const s = await setup(transport);
      try {
        expect(
          await result(
            await s.upload({
              name: "Café Runbook.md",
              folder: "My Docs",
              body: new TextEncoder().encode("# Café\nKeep these bytes.\n"),
            }),
          ),
        ).toEqual({
          added: 1,
          replaced: 0,
          unchanged: 0,
          renamed: 1,
          saved: ["my-docs/cafe-runbook.md"],
          skipped: [],
          skippedTotal: 0,
        });
        const tar = await new Bun.Archive({
          "Run Book.md": "# Run book\n",
        }).bytes();
        expect(
          await result(
            await s.upload({ body: tar, name: null, folder: "tar" }),
          ),
        ).toMatchObject({
          added: 1,
          renamed: 1,
          saved: ["tar/run-book.md"],
          skippedTotal: 0,
        });
        const zip = await Bun.file(
          new URL("../../fixtures/archives/descriptor.zip", import.meta.url),
        ).bytes();
        expect(
          await result(
            await s.upload({ body: zip, name: "ignored.md", folder: "zip" }),
          ),
        ).toMatchObject({
          added: 1,
          saved: ["zip/a.md"],
          skippedTotal: 0,
        });
        const files = s.app.knowledge.list(s.projectId).files;
        expect(files.map((file) => file.name).sort()).toEqual([
          "my-docs/cafe-runbook.md",
          "tar/run-book.md",
          "zip/a.md",
        ]);
        for (const [name, text] of [
          ["my-docs/cafe-runbook.md", "# Café\nKeep these bytes.\n"],
          ["tar/run-book.md", "# Run book\n"],
          ["zip/a.md", "alpha\n"],
        ]) {
          const file = files.find((file) => file.name === name)!;
          expect(s.app.knowledge.read(s.projectId, file.id).text).toBe(text);
          expect(file.author).toEqual({
            kind: "user",
            id: s.owner.id,
            name: "writer",
            sessionId: null,
            origin: null,
          });
        }
      } finally {
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: transport accepts over 16 MiB and refuses over 32 MiB`,
    async () => {
      const s = await setup(transport);
      try {
        const oversized = await s.upload({
          body: new Uint8Array(MAX_ARCHIVE_UPLOAD + 1),
        });
        expect(oversized.status).toBe(413);
        await oversized.text();
        expect(
          await result(
            await s.upload({
              name: "large.md",
              body: new Uint8Array(20 * 1024 * 1024).fill(0x61),
            }),
          ),
        ).toEqual({
          added: 0,
          replaced: 0,
          unchanged: 0,
          renamed: 0,
          saved: [],
          skipped: [{ index: 0, name: "large.md", reason: "too-big" }],
          skippedTotal: 1,
        });
        expect(await result(await s.upload())).toMatchObject({ added: 1 });
        expect(s.app.knowledge.list(s.projectId).files).toHaveLength(1);
      } finally {
        await s.close();
      }
    },
  );
}

test.serial(
  "a declared upload overflow is refused before pulling its body",
  async () => {
    const s = await setup();
    let pulled = false;
    try {
      const request = s.request({
        headers: { "content-length": String(MAX_ARCHIVE_UPLOAD + 1) },
        body: new ReadableStream<Uint8Array>(
          {
            pull() {
              pulled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      });
      const response = await s.send(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "body too large" });
      expect(pulled).toBe(false);
      expect(request.body?.locked).toBe(false);
      expect(await result(await s.upload())).toMatchObject({ added: 1 });
    } finally {
      await s.close();
    }
  },
);

test.serial(
  "one upload per user runs while other users and later uploads are admitted",
  async () => {
    const s = await setup();
    const body = stalledBody();
    const stop = new AbortController();
    const pending = s.upload({ body: body.body, signal: stop.signal });
    try {
      await body.started;
      const team = s.app.projects.createTeam({
        ownerId: s.owner.id,
        name: "upload-team",
        description: "",
        now: s.app.now.value,
      });
      s.app.projects.addMember(team.id, s.owner.id, s.app.now.value);
      const second = await s.upload({
        projectId: team.id,
        name: "second.md",
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "an upload is running" });
      expect(
        await result(
          await s.upload({
            cookie: s.admin.cookie,
            projectId: s.adminProjectId,
          }),
        ),
      ).toMatchObject({ added: 1 });
      body.finish("first\n");
      expect(await result(await pending)).toMatchObject({ added: 1 });
      expect(await result(await s.upload({ name: "second.md" }))).toMatchObject(
        { added: 1 },
      );
      expect(s.app.knowledge.list(s.projectId).files).toHaveLength(2);
    } finally {
      body.cleanup();
      stop.abort();
      await pending.catch(() => {});
      await s.close();
    }
  },
);

test.serial(
  "a queued upload expires without reading and releases its user's guard",
  async () => {
    const s = await setup();
    const slots = await holdSlots();
    const stop = new AbortController();
    let pulled = false;
    const pending = s.upload({
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      signal: stop.signal,
    });
    try {
      expect((await s.upload()).status).toBe(409);
      expect(pulled).toBe(false);
      s.app.now.value += ARCHIVE_DEADLINE_MS;
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "the server is busy, try again",
      });
      expect(pulled).toBe(false);
      slots[0]!();
      expect(await result(await s.upload())).toMatchObject({ added: 1 });
    } finally {
      stop.abort();
      for (const release of slots) release();
      await pending.catch(() => {});
      await s.close();
    }
  },
);

test.serial(
  "a stalled upload holds its slot and guard until deadline cancellation settles",
  async () => {
    const s = await setup();
    const slots = await holdSlots(KNOWLEDGE_COMMANDS_IN_FLIGHT - 1);
    const body = stalledBody();
    const stop = new AbortController();
    const probeStop = new AbortController();
    const request = s.request({ body: body.body, signal: stop.signal });
    let settled = false;
    const pending = s.send(request).finally(() => {
      settled = true;
    });
    let probe: Promise<void> | undefined;
    let probeRelease: (() => void) | undefined;
    try {
      await body.started;
      probe = acquire(probeStop.signal).then((release) => {
        probeRelease = release;
      });
      s.app.now.value += ARCHIVE_DEADLINE_MS;
      await body.cancelled;
      expect((await s.upload()).status).toBe(409);
      expect(settled).toBe(false);
      expect(probeRelease).toBeUndefined();
      expect(request.body?.locked).toBe(true);
      body.cleanup();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "the server is busy, try again",
      });
      expect(request.body?.locked).toBe(false);
      expect(s.app.knowledge.list(s.projectId).files).toEqual([]);
      await probe;
      expect(probeRelease).toBeFunction();
      probeRelease!();
      expect(await result(await s.upload())).toMatchObject({ added: 1 });
    } finally {
      body.cleanup();
      stop.abort();
      probeStop.abort();
      probeRelease?.();
      for (const release of slots) release();
      await probe?.catch(() => {});
      await pending.catch(() => {});
      await s.close();
    }
  },
);

for (const phase of ["queued", "reading"] as const) {
  test.serial(
    `request cancellation while ${phase} releases upload admission`,
    async () => {
      const s = await setup();
      const slots = await holdSlots(
        KNOWLEDGE_COMMANDS_IN_FLIGHT - (phase === "reading" ? 1 : 0),
      );
      const body = stalledBody();
      const stop = new AbortController();
      const request = s.request({ body: body.body, signal: stop.signal });
      const pending = s.send(request).then(
        (response) => response,
        (error: unknown) => error,
      );
      try {
        if (phase === "reading") await body.started;
        expect((await s.upload()).status).toBe(409);
        body.cleanup();
        stop.abort(new DOMException("client left", "AbortError"));
        if (phase === "reading") await body.cancelled;
        const outcome = await pending;
        if (outcome instanceof Response) {
          expect(outcome.status).toBeGreaterThanOrEqual(400);
        } else {
          expect(outcome).toBeInstanceOf(Error);
        }
        expect(request.body?.locked).toBe(false);
        expect(s.app.knowledge.list(s.projectId).files).toEqual([]);
        if (phase === "queued") slots[0]!();
        expect(await result(await s.upload())).toMatchObject({ added: 1 });
      } finally {
        body.cleanup();
        stop.abort();
        for (const release of slots) release();
        await pending;
        await s.close();
      }
    },
  );
}
