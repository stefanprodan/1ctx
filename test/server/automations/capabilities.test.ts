// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parsePatchAutomation,
  parseSaveAutomation,
} from "../../../src/server/automations/parse.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import type { Event } from "../../../src/server/runner/index.ts";
import { MAX_DISABLED_CAPABILITIES } from "../../../src/shared/capabilities.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import {
  automationBody,
  createAutomation,
  settleRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp } from "../../helpers/chat.ts";

async function save(chat: ChatApp, disabledCapabilities: unknown) {
  return chat.member.call(
    "POST",
    `/api/projects/${chat.projectId}/automations`,
    { body: { ...automationBody(chat), disabledCapabilities } },
  );
}

describe("automation capability sets", () => {
  test("create defaults to empty; PATCH preserves omission and replaces the set", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const defaulted = await createAutomation(chat, { name: "defaulted" });
      expect(defaulted.disabledCapabilities).toEqual([]);
      const response = await save(chat, ["web", "web"]);
      expect(response.status).toBe(201);
      const { automation }: { automation: AutomationSummary } =
        await response.json();
      expect(automation.disabledCapabilities).toEqual(["web"]);
      expect(
        chat.app.db
          .query<{ disabled_capabilities: string }, [string]>(
            "select disabled_capabilities from automations where id = ?",
          )
          .get(automation.id),
      ).toEqual({ disabled_capabilities: '["web"]' });
      const preserved = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        { body: { name: "renamed" } },
      );
      expect(preserved.status).toBe(200);
      expect((await preserved.json()).automation.disabledCapabilities).toEqual([
        "web",
      ]);
      const listed = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/automations`,
      );
      expect(
        (await listed.json()).automations.find(
          (row: AutomationSummary) => row.id === automation.id,
        ).disabledCapabilities,
      ).toEqual(["web"]);
      const cleared = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        { body: { disabledCapabilities: [] } },
      );
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).automation.disabledCapabilities).toEqual(
        [],
      );
      expect(chat.app.automations.byId(automation.id)?.revision).toBe(
        automation.revision + 2,
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("malformed, unknown and over-cap sets are 400s without writes", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat);
      for (const disabledCapabilities of [
        null,
        "web",
        {},
        [1],
        ["unknown"],
        ["mcp:"],
        Array(MAX_DISABLED_CAPABILITIES + 1).fill("web"),
      ]) {
        expect(() =>
          parseSaveAutomation({
            ...automationBody(chat),
            disabledCapabilities,
          }),
        ).toThrow(BadRequest);
        expect(() => parsePatchAutomation({ disabledCapabilities })).toThrow(
          "disabledCapabilities",
        );
        for (const response of [
          await save(chat, disabledCapabilities),
          await chat.member.call("PATCH", `/api/automations/${automation.id}`, {
            body: { disabledCapabilities },
          }),
        ]) {
          expect(response.status).toBe(400);
          expect((await response.json()).error).toContain(
            "disabledCapabilities",
          );
        }
        expect(chat.app.automations.byId(automation.id)).toEqual(automation);
        expect(chat.app.automations.count(chat.projectId)).toBe(1);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each(["schedule", "manual"] as const)(
    "%s runs snapshot the latest set and forks keep that copy",
    async (source) => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const events: Event[] = [];
      const start = chat.app.runner.startRun;
      chat.app.runner.startRun = (event) => {
        events.push(event);
        return start(event);
      };
      try {
        const response = await save(chat, ["web"]);
        expect(response.status).toBe(201);
        const { automation }: { automation: AutomationSummary } =
          await response.json();
        const launch = async () => {
          const pending = chat.scripted.next();
          let detail: SessionDetail;
          if (source === "schedule") {
            chat.app.db
              .query("update automations set next_at = ? where id = ?")
              .run(chat.app.now.value, automation.id);
            detail = (await chat.app.automationScheduler.fire(automation.id))!;
            expect(detail).not.toBeNull();
          } else {
            const run = await chat.member.call(
              "POST",
              `/api/automations/${automation.id}/run`,
            );
            expect(run.status).toBe(201);
            detail = await run.json();
          }
          return { detail, script: await pending };
        };
        const first = await launch();
        expect(events[0]?.automation.disabledCapabilities).toEqual(["web"]);
        expect(first.detail.session.disabledCapabilities).toEqual(["web"]);
        const patch = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          { body: { disabledCapabilities: [] } },
        );
        expect(patch.status).toBe(200);
        expect(events[0]?.automation.disabledCapabilities).toEqual(["web"]);
        expect(
          chat.app.sessions.byId(first.detail.session.id)?.disabledCapabilities,
        ).toEqual(["web"]);
        first.script.reply("answer without web");
        await settleRun(chat, first.detail.session.id);
        const reply = chat.app.sessions
          .messages(first.detail.session.id)
          .find((row) => row.kind === "reply")!;
        const fork = await chat.member.call(
          "POST",
          `/api/sessions/${first.detail.session.id}/fork`,
          { body: { messageId: reply.id, agentId: chat.agentId } },
        );
        expect(fork.status).toBe(201);
        expect((await fork.json()).session.disabledCapabilities).toEqual([
          "web",
        ]);
        const runs = chat.app.sessions.runs(automation.id);
        expect(runs.rows[0]?.session.disabledCapabilities).toEqual(["web"]);
        const second = await launch();
        expect(events[1]?.automation.disabledCapabilities).toEqual([]);
        expect(second.detail.session.disabledCapabilities).toEqual([]);
        second.script.reply("answer with web");
        await settleRun(chat, second.detail.session.id);
      } finally {
        chat.app.runner.startRun = start;
        await chat.app.shutdown();
      }
    },
  );
});
