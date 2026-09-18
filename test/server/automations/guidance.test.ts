// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  MAX_AUTOMATION_BODY,
  parsePatchAutomation,
  parseSaveAutomation,
} from "../../../src/server/automations/parse.ts";
import {
  MAX_MEMORY_GUIDANCE,
  MAX_MESSAGE_BYTES,
} from "../../../src/shared/words.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("automation memory guidance", () => {
  test("defaults to empty on create, detail and list", async () => {
    const chat = await chatApp();
    try {
      const body = automationBody(chat);
      expect(body).not.toHaveProperty("memoryGuidance");
      expect(parseSaveAutomation(body).memoryGuidance).toBe("");
      const automation = await createAutomation(chat);
      expect(automation.memoryGuidance).toBe("");
      const detail = await chat.member.call(
        "GET",
        `/api/automations/${automation.id}`,
      );
      expect((await detail.json()).automation.memoryGuidance).toBe("");
      const list = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/automations`,
      );
      expect((await list.json()).automations[0].memoryGuidance).toBe("");
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each([
    ["empty", "", ""],
    ["blank", " \n\t ", ""],
    [
      "sanitized",
      " \u0000Sources\u001b\u0085\u202e\u2066:\n\tfailed hosts \n",
      "Sources:\n\tfailed hosts",
    ],
    [
      "byte limit",
      "é".repeat(MAX_MEMORY_GUIDANCE / 2),
      "é".repeat(MAX_MEMORY_GUIDANCE / 2),
    ],
  ])("stores %s guidance on create and patch", async (_name, raw, clean) => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, {
        memoryGuidance: raw,
      });
      expect(automation.memoryGuidance).toBe(clean);
      const path = `/api/automations/${automation.id}`;
      const set = await chat.member.call("PATCH", path, {
        body: { memoryGuidance: "Last snapshot: the latest result" },
      });
      expect(set.status).toBe(200);
      const kept = await chat.member.call("PATCH", path, {
        body: { name: "guidance-kept" },
      });
      expect((await kept.json()).automation.memoryGuidance).toBe(
        "Last snapshot: the latest result",
      );
      const changed = await chat.member.call("PATCH", path, {
        body: { memoryGuidance: raw },
      });
      expect(changed.status).toBe(200);
      expect((await changed.json()).automation.memoryGuidance).toBe(clean);
      expect(chat.app.automations.byId(automation.id)?.memoryGuidance).toBe(
        clean,
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("rejects non-text and guidance past the byte cap without a write", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, {
        memoryGuidance: "Sources: failed hosts",
      });
      for (const value of [
        null,
        false,
        3,
        {},
        [],
        "a".repeat(MAX_MEMORY_GUIDANCE + 1),
        "é".repeat(MAX_MEMORY_GUIDANCE / 2 + 1),
      ]) {
        const body = { ...automationBody(chat), memoryGuidance: value };
        // the type's refusal names the wire field, the cap's the words
        // a person reads at the field
        const said =
          typeof value === "string" ? "memory guidance" : "memoryGuidance";
        expect(() => parseSaveAutomation(body)).toThrow(said);
        expect(() => parsePatchAutomation({ memoryGuidance: value })).toThrow(
          said,
        );
        const created = await chat.member.call(
          "POST",
          `/api/projects/${chat.projectId}/automations`,
          { body },
        );
        expect(created.status).toBe(400);
        const changed = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          { body: { memoryGuidance: value } },
        );
        expect(changed.status).toBe(400);
        expect(chat.app.automations.byId(automation.id)).toEqual(automation);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("allows instructions and guidance at their caps in one body", async () => {
    const chat = await chatApp();
    try {
      const memoryGuidance = "g".repeat(MAX_MEMORY_GUIDANCE);
      const body = automationBody(chat, {
        instructions: "a".repeat(MAX_MESSAGE_BYTES),
        memoryGuidance,
      });
      expect(
        new TextEncoder().encode(JSON.stringify(body)).length,
      ).toBeLessThan(MAX_AUTOMATION_BODY);
      const automation = await createAutomation(chat, body);
      expect(automation.instructions).toBe(body.instructions);
      expect(automation.memoryGuidance).toBe(memoryGuidance);
    } finally {
      await chat.app.shutdown();
    }
  });
});
