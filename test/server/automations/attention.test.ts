// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who marks an automation's runs: its mode defaults to agent on create
// and is kept by a PATCH that leaves it out; the words on when are
// cleaned and capped; the list tells members whether the decider mode
// can ask, and nothing else about the decision.

import { describe, expect, test } from "bun:test";
import {
  parsePatchAutomation,
  parseSaveAutomation,
} from "../../../src/server/automations/parse.ts";
import { MAX_ATTENTION_GUIDANCE } from "../../../src/shared/words.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("an automation's attention mode", () => {
  test("defaults to agent with no words, and a PATCH keeps or changes it", async () => {
    const chat = await chatApp();
    try {
      const { attentionMode: _, ...body } = automationBody(chat);
      expect(parseSaveAutomation(body)).toMatchObject({
        attentionMode: "agent",
        attentionGuidance: "",
      });
      const created = await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/automations`,
        { body },
      );
      expect(created.status).toBe(201);
      const automation = (await created.json()).automation;
      expect(automation.attentionMode).toBe("agent");
      expect(automation.attentionGuidance).toBe("");
      const path = `/api/automations/${automation.id}`;
      const set = await chat.member.call("PATCH", path, {
        body: {
          editRevision: chat.app.automations.byId(automation.id)!.editRevision,
          attentionMode: "decider",
          attentionGuidance: " \u0000Only when Flux is behind. ",
        },
      });
      expect(set.status).toBe(200);
      const kept = await chat.member.call("PATCH", path, {
        body: {
          editRevision: chat.app.automations.byId(automation.id)!.editRevision,
          name: "renamed",
        },
      });
      expect((await kept.json()).automation).toMatchObject({
        attentionMode: "decider",
        attentionGuidance: "Only when Flux is behind.",
      });
      const off = await chat.member.call("PATCH", path, {
        body: {
          editRevision: chat.app.automations.byId(automation.id)!.editRevision,
          attentionMode: "off",
        },
      });
      expect((await off.json()).automation.attentionMode).toBe("off");
      expect(chat.app.automations.byId(automation.id)).toMatchObject({
        attentionMode: "off",
        attentionGuidance: "Only when Flux is behind.",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses another mode and words past the cap without a write", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat);
      const refused: [Record<string, unknown>, string][] = [
        [{ attentionMode: "always" }, "attentionMode"],
        [{ attentionMode: null }, "attentionMode"],
        [{ attentionGuidance: 3 }, "attentionGuidance"],
        [
          { attentionGuidance: "a".repeat(MAX_ATTENTION_GUIDANCE + 1) },
          "attention guidance",
        ],
      ];
      for (const [fields, said] of refused) {
        expect(() =>
          parseSaveAutomation({ ...automationBody(chat), ...fields }),
        ).toThrow(said);
        expect(() =>
          parsePatchAutomation({ ...fields, editRevision: 0 }),
        ).toThrow(said);
        const changed = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          {
            body: {
              ...fields,
              editRevision: chat.app.automations.byId(automation.id)!
                .editRevision,
            },
          },
        );
        expect(changed.status).toBe(400);
        expect(chat.app.automations.byId(automation.id)).toEqual(automation);
      }
      const longest = "é".repeat(MAX_ATTENTION_GUIDANCE / 2);
      const saved = await createAutomation(chat, {
        name: "longest",
        attentionGuidance: longest,
      });
      expect(saved.attentionGuidance).toBe(longest);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the list says whether the decider can be asked", async () => {
    const chat = await chatApp();
    try {
      const path = `/api/projects/${chat.projectId}/automations`;
      const read = async () =>
        (await (await chat.member.call("GET", path)).json()).deciderOn;
      const decision = (enabled: boolean) =>
        chat.admin.call("PUT", "/api/decisions/run-attention", {
          body: {
            enabled,
            deciderId: null,
            options: {
              "all-good": "fine",
              "needs-attention": "not fine",
            },
          },
        });
      expect((await decision(true)).status).toBe(200);
      // on, but no decider to ask
      expect(await read()).toBe(false);
      chat.app.deciders.store.create({
        name: "judge",
        providerId: chat.providerId,
        model: "kev-latest",
        contextLength: 32000,
        promptPrice: null,
        now: chat.app.now.value,
      });
      expect(await read()).toBe(true);
      expect((await decision(false)).status).toBe(200);
      expect(await read()).toBe(false);
    } finally {
      await chat.app.shutdown();
    }
  });
});
