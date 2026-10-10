// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { OWN_MEMORY_GUIDANCE } from "../../../src/shared/automation-defaults.ts";
import {
  MAX_ATTENTION_GUIDANCE,
  MAX_MEMORY_GUIDANCE,
} from "../../../src/shared/words.ts";
import {
  createProposal,
  draftApp,
  press,
  proposalRound,
  proposals,
} from "../../helpers/automation-drafts.ts";
import { createAutomation } from "../../helpers/automations.ts";
import { startChat } from "../../helpers/chat.ts";
import { settled } from "../../helpers/subagents.ts";

describe("memory and attention in a proposal", () => {
  test("a create with all three confirms into a task holding them", async () => {
    const chat = await draftApp();
    try {
      const { drafts } = await proposals(chat, [
        {
          ...createProposal("kept"),
          ownMemory: true,
          memoryGuidance: "Keep sources that fail.",
          attentionGuidance: "A price moved past its limit.",
        },
        {
          ...createProposal("from-files"),
          ownMemory: false,
          attentionGuidance: "A script failed.",
        },
        createProposal("defaults"),
      ]);
      const tasks = [];
      for (const draft of drafts) {
        expect((await press(chat, draft.id)).status).toBe(200);
        const id = chat.app.automationDrafts.byId(draft.id)!
          .createdAutomationId!;
        tasks.push(chat.app.automations.byId(id)!);
      }
      expect(tasks[0]).toMatchObject({
        ownMemory: true,
        memoryGuidance: "Keep sources that fail.",
        attentionGuidance: "A price moved past its limit.",
      });
      // the default guidance is own memory's, so none is stored without it
      expect(tasks[1]).toMatchObject({
        ownMemory: false,
        memoryGuidance: "",
        attentionGuidance: "A script failed.",
      });
      expect(tasks[2]).toMatchObject({
        ownMemory: true,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
        attentionMode: "agent",
        attentionGuidance: "",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an update of each alone confirms into the task", async () => {
    const chat = await draftApp();
    try {
      let task = await createAutomation(chat, {
        ownMemory: true,
        memoryGuidance: "Keep everything.",
        attentionMode: "agent",
      });
      for (const patch of [
        { memoryGuidance: "Keep sources that fail." },
        { attentionGuidance: "A script failed." },
        { ownMemory: false },
      ]) {
        const { drafts } = await proposals(chat, [
          { action: "update", id: task.id, ...patch },
        ]);
        expect(drafts[0]!.fields).toEqual(patch);
        expect((await press(chat, drafts[0]!.id)).status).toBe(200);
        task = chat.app.automations.byId(task.id)!;
        expect(task).toMatchObject(patch);
      }
      expect(task).toMatchObject({
        ownMemory: false,
        memoryGuidance: "Keep sources that fail.",
        attentionGuidance: "A script failed.",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("turning own memory on fills a blank guidance, as the page does", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat, { ownMemory: false });
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, ownMemory: true },
      ]);
      expect(drafts[0]!.fields).toEqual({
        ownMemory: true,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("own memory on keeps a custom guidance, and off drops only the default", async () => {
    const chat = await draftApp();
    try {
      const custom = await createAutomation(chat, {
        name: "custom",
        ownMemory: false,
        memoryGuidance: "Keep failing sources.",
      });
      const kept = await createAutomation(chat, {
        name: "kept",
        ownMemory: true,
        memoryGuidance: "Keep failing sources.",
      });
      const fallback = await createAutomation(chat, {
        name: "fallback",
        ownMemory: true,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
      });
      const { drafts } = await proposals(chat, [
        { action: "update", id: custom.id, ownMemory: true },
        { action: "update", id: kept.id, ownMemory: false },
        { action: "update", id: fallback.id, ownMemory: false },
      ]);
      expect(drafts.map((draft) => draft.fields)).toEqual([
        { ownMemory: true },
        { ownMemory: false },
        { ownMemory: false, memoryGuidance: "" },
      ]);
      for (const draft of drafts) {
        expect((await press(chat, draft.id)).status).toBe(200);
      }
      expect(chat.app.automations.byId(custom.id)!.memoryGuidance).toBe(
        "Keep failing sources.",
      );
      expect(chat.app.automations.byId(kept.id)!.memoryGuidance).toBe(
        "Keep failing sources.",
      );
      expect(chat.app.automations.byId(fallback.id)!.memoryGuidance).toBe("");
      // a later turn-on takes the default of that day
      const again = await proposals(chat, [
        { action: "update", id: fallback.id, ownMemory: true },
      ]);
      expect(again.drafts[0]!.fields).toEqual({
        ownMemory: true,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("own memory off on a task already without it changes nothing", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat, {
        ownMemory: false,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
      });
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, ownMemory: false },
      ]);
      expect(drafts[0]!.fields).toEqual({ ownMemory: false });
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
      expect(chat.app.automations.byId(task.id)).toEqual(task);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("clearing the attention guidance of a task with attention off is allowed", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat, { attentionMode: "off" });
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, attentionGuidance: "" },
      ]);
      expect(drafts[0]!.fields).toEqual({ attentionGuidance: "" });
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a proposed name is shaped as the page shapes it", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      const { drafts } = await proposals(chat, [
        { ...createProposal(), name: "Weekly Bun and Preact CVE watch  " },
        { action: "update", id: task.id, name: "Ședință Zilnică v2.1" },
      ]);
      expect(drafts.map((draft) => draft.fields.name)).toEqual([
        "weekly-bun-and-preact-cve-watch",
        "sedinta-zilnica-v2-1",
      ]);
      for (const draft of drafts) {
        expect((await press(chat, draft.id)).status).toBe(200);
      }
      expect(chat.app.automations.byId(task.id)!.name).toBe(
        "sedinta-zilnica-v2-1",
      );
      const { sessionId, script } = await startChat(chat);
      const answer = await proposalRound(chat, script, [
        { ...createProposal(), name: "!!! ???" },
        { action: "update", id: task.id, name: "---" },
      ]);
      const messages = answer.body.messages as {
        role: string;
        content: string;
      }[];
      const tools = messages.filter((m) => m.role === "tool");
      for (const tool of tools) {
        expect(tool.content).toStartWith("Error: name must be");
      }
      expect(tools).toHaveLength(2);
      expect(chat.app.automationDrafts.bySession(sessionId)).toEqual([]);
      answer.reply("Nothing proposed.");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an unread guidance and one past its limit write no draft", async () => {
    const chat = await draftApp();
    try {
      const noMemory = await createAutomation(chat, {
        name: "no-memory",
        ownMemory: false,
        attentionMode: "agent",
      });
      const attentionOff = await createAutomation(chat, {
        name: "attention-off",
        ownMemory: true,
        attentionMode: "off",
      });
      const { sessionId, script } = await startChat(chat);
      const refused = [
        { ...createProposal(), ownMemory: false, memoryGuidance: "Keep it." },
        { action: "update", id: noMemory.id, memoryGuidance: "Keep it." },
        {
          action: "update",
          id: attentionOff.id,
          ownMemory: false,
          memoryGuidance: "Keep it.",
        },
        {
          ...createProposal(),
          memoryGuidance: "x".repeat(MAX_MEMORY_GUIDANCE + 1),
        },
        {
          action: "update",
          id: noMemory.id,
          attentionGuidance: "x".repeat(MAX_ATTENTION_GUIDANCE + 1),
        },
        { action: "update", id: attentionOff.id, attentionGuidance: "Alert." },
      ];
      const answer = await proposalRound(chat, script, refused);
      const messages = answer.body.messages as {
        role: string;
        content: string;
      }[];
      const tools = messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content);
      expect(tools.slice(0, 3)).toEqual(
        Array(3).fill(
          "Error: memoryGuidance needs ownMemory. Leave it out when the task keeps no memory.",
        ),
      );
      expect(tools[3]).toContain(
        `memory guidance must be at most ${MAX_MEMORY_GUIDANCE} bytes`,
      );
      expect(tools[4]).toContain(
        `attention guidance must be at most ${MAX_ATTENTION_GUIDANCE} bytes`,
      );
      expect(tools[5]).toContain(`/automations/${attentionOff.id}`);
      expect(tools[5]).toContain("turn attention on first");
      expect(chat.app.automationDrafts.bySession(sessionId)).toEqual([]);
      answer.reply("Nothing proposed.");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
