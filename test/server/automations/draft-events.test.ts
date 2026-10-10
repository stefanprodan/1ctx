// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { proposeTask } from "../../../src/server/automations/propose.ts";
import { transact } from "../../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { AutomationDraft } from "../../../src/shared/contracts/automation-draft.ts";
import { hasWatchedDrafts, isDraftFrame } from "../../../src/shared/socket.ts";
import { FAIL_CONFIRM } from "../../fixtures/automations/draft-failure.ts";
import {
  createProposal,
  draftApp,
  press,
  proposalRound,
  proposals,
} from "../../helpers/automation-drafts.ts";
import { createAutomation, settleRun } from "../../helpers/automations.ts";
import { FLASH, startChat } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";
import { settled } from "../../helpers/subagents.ts";

describe("draft state frames", () => {
  test.serial(
    "new pending proposals reach the open chat only, and rollbacks publish nothing",
    async () => {
      const chat = await draftApp();
      const seen: BusEvent[] = [];
      const committed: boolean[] = [];
      const stop = subscribe((event) => {
        if (event.type !== "draft.changed") return;
        seen.push(event);
        committed.push(!chat.app.db.inTransaction);
      }, silent);
      try {
        const task = await createAutomation(chat);
        const { sessionId, script } = await startChat(chat);
        const conn = await watcher(chat);
        const unwatched = await watcher(chat);
        const hidden = await watcher(chat, chat.admin);
        const other = await proposals(chat, [createProposal("other")]);
        const elsewhere = await watcher(chat);
        watch(chat, elsewhere, other.sessionId);
        seen.length = 0;
        committed.length = 0;
        watch(chat, conn, sessionId);
        const answer = await proposalRound(chat, script, [
          createProposal(),
          { action: "update", id: task.id, once: true },
          { action: "suspend", id: task.id },
          { action: "resume", id: task.id },
          { action: "run", id: task.id },
        ]);
        const sent = frames(conn, "draft");
        const rows = chat.app.automationDrafts.bySession(sessionId);
        expect(sent).toHaveLength(5);
        expect(sent.every(isDraftFrame)).toBe(true);
        expect(committed).toEqual([true, true, true, true, true]);
        for (const frame of sent) {
          expect("draft" in frame).toBe(true);
          if (!("draft" in frame)) continue;
          expect(frame).toEqual({
            type: "draft",
            sessionId,
            draft: rows.find((row) => row.id === frame.draft.id)!,
          });
          expect(frame.draft.state).toBe("pending");
        }
        const detail = await chat.member.call(
          "GET",
          `/api/sessions/${sessionId}`,
        );
        expect((await detail.json()).automationDrafts).toEqual(rows);
        const stored = chat.app.automationDrafts.byId(rows[0]!.id)!;
        const session = chat.app.sessions.byId(sessionId)!;
        expect(() =>
          transact(chat.app.db, () => {
            proposeTask(
              {
                db: chat.app.db,
                store: chat.app.automations,
                drafts: chat.app.automationDrafts,
                runDeadlineMs: () => DEFAULT_LIMITS.runDeadlineMs,
              },
              {
                ...stored,
                projectId: session.projectId,
                now: chat.app.now.value,
              },
            );
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(rows).toEqual(chat.app.automationDrafts.bySession(sessionId));
        expect(seen).toHaveLength(5);
        expect(frames(conn, "draft")).toEqual(sent);
        expect(chat.app.sessions.byId(sessionId)).toEqual(session);
        expect(frames(unwatched, "draft")).toEqual([]);
        expect(frames(hidden, "draft")).toEqual([]);
        expect(frames(elsewhere, "draft")).toEqual([]);
        answer.reply("Waiting for confirmation.");
        await settled(chat, sessionId);
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "confirm, dismiss, stale and expiry at confirm reach only the chat's watchers after commit",
    async () => {
      const chat = await draftApp();
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (event.type !== "draft.changed") return;
        seen.push(event);
        expect(chat.app.db.inTransaction).toBe(false);
        if (!("draft" in event.data)) throw new Error("unexpected removal");
        const draft = event.data.draft;
        expect(
          chat.app.automationDrafts
            .bySession(event.data.sessionId)
            .find((row) => row.id === draft.id)!,
        ).toEqual(draft);
      }, silent);
      try {
        const task = await createAutomation(chat);
        const { sessionId, drafts } = await proposals(chat, [
          createProposal(),
          createProposal("dismiss"),
          { action: "update", id: task.id, instructions: "draft" },
          createProposal("expires"),
          { action: "run", id: task.id },
        ]);
        expect(seen).toHaveLength(5);
        seen.length = 0;
        const conn = await watcher(chat);
        const unwatched = await watcher(chat);
        const hidden = await watcher(chat, chat.admin);
        watch(chat, conn, sessionId);
        expect((await press(chat, drafts[0]!.id)).status).toBe(200);
        expect((await press(chat, drafts[1]!.id, "dismiss")).status).toBe(200);
        const next = chat.scripted.next();
        expect((await press(chat, drafts[4]!.id)).status).toBe(200);
        const runId = chat.app.automationDrafts.byId(drafts[4]!.id)!
          .runSessionId!;
        (await next).reply("Done.");
        await settleRun(chat, runId);
        await chat.member.call("PATCH", `/api/automations/${task.id}`, {
          body: { instructions: "page", editRevision: task.editRevision },
        });
        expect((await press(chat, drafts[2]!.id)).status).toBe(409);
        chat.app.now.value = drafts[3]!.expiresAt;
        expect((await press(chat, drafts[3]!.id)).status).toBe(409);
        const sent = frames(conn, "draft").filter(
          (frame): frame is Extract<typeof frame, { draft: AutomationDraft }> =>
            "draft" in frame,
        );
        expect(sent.map((f) => f.draft.state)).toEqual([
          "confirmed",
          "dismissed",
          "confirmed",
          "stale",
          "expired",
        ]);
        expect(sent.every(isDraftFrame)).toBe(true);
        expect(sent[0]).toEqual({
          type: "draft",
          sessionId,
          draft: chat.app.automationDrafts
            .bySession(sessionId)
            .find((row) => row.id === drafts[0]!.id)!,
        });
        expect(sent[0]!.draft.decidedBy).toEqual({
          id: chat.memberId,
          username: "casey",
        });
        expect(sent[0]!.draft.decidedAt).toBe(drafts[0]!.createdAt);
        expect(sent[2]!.draft.runSessionId).toBe(runId);
        expect(sent[3]!.draft.decidedBy).toBeNull();
        for (const frame of sent) {
          expect(frame.draft).toEqual(
            chat.app.automationDrafts
              .bySession(sessionId)
              .find((row) => row.id === frame.draft.id)!,
          );
        }
        expect(frames(unwatched, "draft")).toEqual([]);
        expect(frames(hidden, "draft")).toEqual([]);
        expect(seen).toHaveLength(5);
        const reconnect = await watcher(chat);
        watch(chat, reconnect, sessionId);
        const detail = await chat.member.call(
          "GET",
          `/api/sessions/${sessionId}`,
        );
        expect((await detail.json()).automationDrafts).toEqual(
          chat.app.automationDrafts.bySession(sessionId),
        );
        expect(frames(reconnect, "draft")).toEqual([]);
        expect((await press(chat, drafts[0]!.id)).status).toBe(409);
        expect(seen).toHaveLength(5);
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "sweep expiry, archive expiry and regenerate removal publish only committed changes",
    async () => {
      const chat = await draftApp();
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (event.type === "draft.changed") seen.push(event);
      }, silent);
      try {
        const archived = await proposals(chat, [createProposal("archived")]);
        seen.length = 0;
        const conn = await watcher(chat);
        watch(chat, conn, archived.sessionId);
        expect(() =>
          transact(chat.app.db, () => {
            chat.app.sessions.archive(
              archived.sessionId,
              "manual",
              chat.memberId,
              chat.app.now.value,
            );
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(seen).toHaveLength(0);
        expect(frames(conn, "draft")).toEqual([]);
        expect(
          chat.app.automationDrafts.byId(archived.drafts[0]!.id)!.state,
        ).toBe("pending");
        expect(
          (
            await chat.member.call(
              "POST",
              `/api/sessions/${archived.sessionId}/archive`,
            )
          ).status,
        ).toBe(204);
        expect(frames(conn, "draft")).toEqual([
          {
            type: "draft",
            sessionId: archived.sessionId,
            draft: chat.app.automationDrafts.bySession(archived.sessionId)[0],
          },
        ]);
        expect(
          chat.app.automationDrafts.bySession(archived.sessionId)[0]!.state,
        ).toBe("expired");
        const swept = await proposals(chat, [createProposal("swept")]);
        watch(chat, conn, swept.sessionId);
        chat.app.now.value = swept.drafts[0]!.expiresAt;
        chat.app.sweep();
        expect(frames(conn, "draft").at(-1)).toEqual({
          type: "draft",
          sessionId: swept.sessionId,
          draft: chat.app.automationDrafts.bySession(swept.sessionId)[0],
        });
        expect(
          chat.app.automationDrafts.bySession(swept.sessionId)[0]!.state,
        ).toBe("expired");
        const regenerated = await proposals(chat, [
          createProposal("removed"),
          createProposal("kept"),
        ]);
        watch(chat, conn, regenerated.sessionId);
        expect(
          (await press(chat, regenerated.drafts[1]!.id, "dismiss")).status,
        ).toBe(200);
        const users = chat.app.sessions
          .messages(regenerated.sessionId)
          .filter((m) => m.kind === "user");
        expect(() =>
          transact(chat.app.db, () => {
            const send = chat.app.sessions.createSend({
              sessionId: regenerated.sessionId,
              userId: chat.memberId,
              agentId: chat.agentId,
              providerId: chat.providerId,
              model: FLASH,
              firstMessageId: users[0]!.id,
              now: chat.app.now.value,
            });
            chat.app.sessions.replaceSend(users, send.id);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(seen).toHaveLength(6);
        const next = chat.scripted.next();
        expect(
          (
            await chat.member.call(
              "POST",
              `/api/sessions/${regenerated.sessionId}/regenerate`,
              { body: {} },
            )
          ).status,
        ).toBe(201);
        (await next).reply("Done.");
        await settled(chat, regenerated.sessionId);
        const removed = frames(conn, "draft").at(-1)!;
        expect(removed).toEqual({
          type: "draft",
          sessionId: regenerated.sessionId,
          draftId: regenerated.drafts[0]!.id,
          removed: true,
        });
        expect(seen).toHaveLength(7);
        expect(
          chat.app.automationDrafts
            .bySession(regenerated.sessionId)
            .map((d) => d.state),
        ).toEqual(["dismissed"]);
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "refused proposals publish nothing, and a regenerate removes each pending one",
    async () => {
      const chat = await draftApp();
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (event.type === "draft.changed") seen.push(event);
      }, silent);
      try {
        await createAutomation(chat, { name: "taken" });
        const { sessionId, script } = await startChat(chat);
        const conn = await watcher(chat);
        watch(chat, conn, sessionId);
        const answer = await proposalRound(chat, script, [
          createProposal("taken"),
          { ...createProposal("bad"), schedule: "nope" },
          { action: "update", id: "missing", once: true },
          ...["a", "b", "c", "d", "e", "f"].map((n) =>
            createProposal(`task-${n}`),
          ),
        ]);
        answer.reply("Waiting for confirmation.");
        await settled(chat, sessionId);
        const refusals = chat.app.sessions
          .messages(sessionId)
          .filter((m) => m.kind === "tool" && m.content.startsWith("Error:"));
        expect(refusals).toHaveLength(4);
        const rows = chat.app.automationDrafts.bySession(sessionId);
        expect(rows.map((d) => d.fields.name).sort()).toEqual([
          "task-a",
          "task-b",
          "task-c",
          "task-d",
          "task-e",
        ]);
        const sent = frames(conn, "draft");
        expect(seen).toHaveLength(5);
        expect(sent).toHaveLength(5);
        expect(
          sent.map((f) => ("draft" in f ? f.draft.id : null)).sort(),
        ).toEqual(rows.map((d) => d.id).sort());
        const next = chat.scripted.next();
        expect(
          (
            await chat.member.call(
              "POST",
              `/api/sessions/${sessionId}/regenerate`,
              { body: {} },
            )
          ).status,
        ).toBe(201);
        (await next).reply("Done.");
        await settled(chat, sessionId);
        const removed = frames(conn, "draft").slice(5);
        expect(removed.every(isDraftFrame)).toBe(true);
        expect(
          removed.map((f) => ("removed" in f ? f.draftId : null)).sort(),
        ).toEqual(rows.map((d) => d.id).sort());
        expect(seen).toHaveLength(10);
        expect(chat.app.automationDrafts.bySession(sessionId)).toEqual([]);
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "a draft written between the detail read and the watch arrives with watched",
    async () => {
      const chat = await draftApp();
      try {
        const { sessionId, script } = await startChat(chat);
        const detail = await chat.member.call(
          "GET",
          `/api/sessions/${sessionId}`,
        );
        expect((await detail.json()).automationDrafts).toEqual([]);
        const answer = await proposalRound(chat, script, [createProposal()]);
        answer.reply("Waiting for confirmation.");
        await settled(chat, sessionId);
        const conn = await watcher(chat);
        watch(chat, conn, sessionId);
        const rows = chat.app.automationDrafts.bySession(sessionId);
        expect(rows).toHaveLength(1);
        expect(frames(conn, "watched")).toEqual([
          expect.objectContaining({ sessionId, drafts: rows }),
        ]);
        expect(hasWatchedDrafts(frames(conn, "watched")[0])).toBe(true);
        expect(frames(conn, "draft")).toEqual([]);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "a failed confirm transaction abandons its run place and launches and publishes nothing",
    async () => {
      const chat = await draftApp();
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => seen.push(event), silent);
      try {
        const task = await createAutomation(chat);
        const { drafts, sessionId } = await proposals(chat, [
          { action: "run", id: task.id },
        ]);
        const conn = await watcher(chat);
        watch(chat, conn, sessionId);
        const count = chat.app.sessions.count(chat.projectId);
        const chats = chat.scripted.chats();
        const beforeEvents = seen.length;
        chat.app.db.exec(FAIL_CONFIRM);
        expect((await press(chat, drafts[0]!.id)).status).toBe(500);
        expect(chat.app.automationDrafts.byId(drafts[0]!.id)).toMatchObject({
          state: "pending",
          runSessionId: null,
          decidedAt: null,
        });
        expect(chat.app.automations.byId(task.id)).toEqual(task);
        expect(chat.app.sessions.count(chat.projectId)).toBe(count);
        expect(chat.app.runner.registry.values()).toHaveLength(0);
        expect(chat.scripted.chats()).toBe(chats);
        expect(seen).toHaveLength(beforeEvents);
        expect(frames(conn, "draft")).toEqual([]);
        chat.app.db.exec("drop trigger fail_draft_confirm");
        const next = chat.scripted.next();
        expect((await press(chat, drafts[0]!.id)).status).toBe(200);
        (await next).reply("Done.");
        await settleRun(
          chat,
          chat.app.automationDrafts.byId(drafts[0]!.id)!.runSessionId!,
        );
      } finally {
        stop();
        await chat.app.shutdown();
      }
    },
  );
});
