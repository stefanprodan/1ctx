// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  ARCHIVE_DEADLINE_MS,
  KNOWLEDGE_COMMANDS_IN_FLIGHT,
  MAX_ARCHIVE_UPLOAD,
} from "../../../src/server/knowledge/limits.ts";
import { acquire, acquireUpload } from "../../../src/server/knowledge/queue.ts";
import { stage } from "../../../src/server/knowledge/stage.ts";
import { Conflict } from "../../../src/server/lib/errors.ts";
import { setup } from "./helpers.ts";
import { setupUploads, staged, stalledBody } from "./uploads-helpers.ts";

async function holdSlots(count = KNOWLEDGE_COMMANDS_IN_FLIGHT) {
  const releases: (() => void)[] = [];
  for (let i = 0; i < count; i++) {
    releases.push(await acquire(new AbortController().signal));
  }
  return releases;
}

async function waitForUpload(userId: string) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    try {
      acquireUpload(userId)();
    } catch (error) {
      if (error instanceof Conflict) return;
      throw error;
    }
    await Bun.sleep(1);
  }
  throw new Error("the upload was not admitted");
}

for (const transport of ["composed", "listener"] as const) {
  test.serial(
    `${transport}: upload routes require login, project access and same origin`,
    async () => {
      const s = await setupUploads(transport);
      try {
        for (const method of ["POST", "GET", "DELETE"]) {
          const suffix = method === "DELETE" ? "/aaaaaaaaaaaa" : "";
          expect((await s.call(method, suffix, { cookie: null })).status).toBe(
            401,
          );
          for (const options of [
            { projectId: s.adminProjectId },
            { projectId: "missing" },
            { cookie: s.admin.cookie },
          ]) {
            const response = await s.call(method, suffix, options);
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: "no such project" });
          }
          if (method !== "GET") {
            expect(
              (
                await s.call(method, suffix, {
                  origin: "https://elsewhere.test",
                })
              ).status,
            ).toBe(403);
          }
        }
        const team = s.app.projects.createTeam({
          ownerId: s.owner.id,
          name: "shared",
          description: "",
          now: s.app.now.value,
        });
        s.app.projects.addMember(team.id, s.owner.id, s.app.now.value);
        const item = await staged(await s.upload({ projectId: team.id }));
        expect(
          (await s.list({ projectId: team.id, cookie: s.admin.cookie })).items,
        ).toEqual([]);
        expect(
          (
            await s.call("DELETE", `/${item.id}`, {
              projectId: team.id,
              cookie: s.admin.cookie,
            })
          ).status,
        ).toBe(404);
        expect((await s.call("DELETE", `/${item.id}`)).status).toBe(404);
        expect(
          (await s.call("DELETE", "/bad-id", { projectId: team.id })).status,
        ).toBe(400);
        expect(
          (await s.call("DELETE", `/${item.id}`, { projectId: team.id }))
            .status,
        ).toBe(204);
        expect(
          (await s.call("DELETE", `/${item.id}`, { projectId: team.id }))
            .status,
        ).toBe(404);
        expect((await s.list({ projectId: team.id })).items).toEqual([]);
      } finally {
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: a pending stage shares the knowledge upload's user guard`,
    async () => {
      const s = await setupUploads(transport);
      const body = stalledBody("first");
      const stop = new AbortController();
      const pending = s.upload({ body: body.body, signal: stop.signal });
      try {
        await waitForUpload(s.owner.id);
        const second = await s.upload();
        expect(second.status).toBe(409);
        expect(await second.json()).toEqual({ error: "an upload is running" });
        const knowledge = await s.client.call(
          "POST",
          `/api/projects/${s.projectId}/knowledge/upload?name=other`,
          { raw: "text" },
        );
        expect(knowledge.status).toBe(409);
        expect(await knowledge.json()).toEqual({
          error: "an upload is running",
        });
        expect(
          await staged(
            await s.upload({
              projectId: s.adminProjectId,
              cookie: s.admin.cookie,
            }),
          ),
        ).toMatchObject({ files: 1 });
        body.finish(" last");
        expect(await staged(await pending)).toMatchObject({ bytes: 10 });
        expect(await staged(await s.upload())).toMatchObject({ files: 1 });
      } finally {
        body.cleanup();
        stop.abort();
        await pending.catch(() => {});
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: the deadline includes the wait for a process slot`,
    async () => {
      const s = await setupUploads(transport);
      const slots = await holdSlots();
      const stop = new AbortController();
      const pending = s.upload({ signal: stop.signal });
      try {
        await waitForUpload(s.owner.id);
        expect((await s.upload()).status).toBe(409);
        s.app.now.value += ARCHIVE_DEADLINE_MS;
        const response = await pending;
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "the server is busy, try again",
        });
        expect((await s.list()).items).toEqual([]);
        slots[0]!();
        expect(await staged(await s.upload())).toMatchObject({ files: 1 });
      } finally {
        stop.abort();
        for (const release of slots) release();
        await pending.catch(() => {});
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: the deadline also stops a body still being read`,
    async () => {
      const s = await setupUploads(transport);
      const body = stalledBody("prefix");
      const stop = new AbortController();
      const pending = s.upload({ body: body.body, signal: stop.signal });
      try {
        await waitForUpload(s.owner.id);
        body.cleanup();
        s.app.now.value += ARCHIVE_DEADLINE_MS;
        const response = await pending;
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "the server is busy, try again",
        });
        expect((await s.list()).items).toEqual([]);
        expect(await staged(await s.upload())).toMatchObject({ files: 1 });
      } finally {
        body.cleanup();
        stop.abort();
        await pending.catch(() => {});
        await s.close();
      }
    },
  );

  test.serial(
    `${transport}: staging uses the 32 MiB listener and body ceiling`,
    async () => {
      const s = await setupUploads(transport);
      try {
        const tooLarge = await s.upload({
          body: new Uint8Array(MAX_ARCHIVE_UPLOAD + 1),
        });
        expect(tooLarge.status).toBe(413);
        await tooLarge.text();
        expect(
          await staged(
            await s.upload({
              name: "large.md",
              body: new Uint8Array(20 * 1024 * 1024).fill(0x61),
            }),
          ),
        ).toMatchObject({
          id: null,
          skipped: [{ reason: "too-big" }],
          skippedTotal: 1,
        });
        expect((await s.list()).items).toEqual([]);
      } finally {
        await s.close();
      }
    },
  );
}

test.serial(
  "staging takes a slot before pulling the body and cancellation releases admission",
  async () => {
    const s = await setupUploads();
    const slots = await holdSlots();
    const stop = new AbortController();
    let pulled = false;
    const req = s.request("POST", "?name=readme.md&attempt=queued", {
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
    const pending = s.send(req);
    try {
      await waitForUpload(s.owner.id);
      expect(pulled).toBe(false);
      stop.abort(new DOMException("client left", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "upload was aborted" });
      expect(pulled).toBe(false);
      expect(req.body?.locked).toBe(false);
      slots[0]!();
      expect(await staged(await s.upload())).toMatchObject({ files: 1 });
    } finally {
      stop.abort();
      for (const release of slots) release();
      await pending.catch(() => {});
      await s.close();
    }
  },
);

test.serial("a declared overflow never pulls the staged body", async () => {
  const s = await setupUploads();
  let pulled = false;
  try {
    const response = await s.upload({
      headers: { "content-length": `${MAX_ARCHIVE_UPLOAD + 1}` },
      body: new ReadableStream(
        {
          pull() {
            pulled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    expect(response.status).toBe(413);
    expect(pulled).toBe(false);
    expect((await s.list()).items).toEqual([]);
  } finally {
    await s.close();
  }
});

test.serial(
  "deadline cleanup settles before releasing the stage's slot and guard",
  async () => {
    const s = await setupUploads();
    const slots = await holdSlots(KNOWLEDGE_COMMANDS_IN_FLIGHT - 1);
    const body = stalledBody();
    const stop = new AbortController();
    const probeStop = new AbortController();
    const req = s.request("POST", "?name=readme.md&attempt=stalled", {
      body: body.body,
      signal: stop.signal,
    });

    let settled = false;
    const pending = s.send(req).finally(() => {
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
      expect(req.body?.locked).toBe(true);
      body.cleanup();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(req.body?.locked).toBe(false);
      await probe;
      expect(probeRelease).toBeFunction();
      probeRelease!();
      expect((await s.list()).items).toEqual([]);
      expect(await staged(await s.upload())).toMatchObject({ files: 1 });
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

test.serial(
  "a deadline reached while judging cannot leave a staged item",
  async () => {
    const s = setup();
    const request = () =>
      new Request("http://uploads.test/?name=note.md&attempt=judged", {
        method: "POST",
        body: "hello",
      });
    try {
      await expect(
        stage(
          {
            db: s.db,
            uploads: s.area.uploads,
            clock: () => s.now.value,
            current() {
              s.now.value += ARCHIVE_DEADLINE_MS;
              return s.caps;
            },
          },
          s.projectId,
          s.author.id,
          request(),
        ),
      ).rejects.toMatchObject({
        status: 503,
        message: "the server is busy, try again",
      });
      expect(s.area.listUploads(s.projectId, s.author.id).items).toEqual([]);
      expect(
        await s.area.stageUpload(s.projectId, s.author.id, request()),
      ).toMatchObject({
        files: 1,
        attempt: "judged",
      });
    } finally {
      s.db.close();
    }
  },
);
