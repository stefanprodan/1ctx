// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { wireTokens } from "../../../src/server/providers/index.ts";
import { makeAutomationTool } from "../../../src/server/tools/builtin/automation.ts";
import { draftApp } from "../../helpers/automation-drafts.ts";
import { startChat } from "../../helpers/chat.ts";
import { settled } from "../../helpers/subagents.ts";

test("the Config catalog shows the main chat's proposal schema, description and token count", async () => {
  const chat = await draftApp();
  try {
    const response = await chat.admin.call("GET", "/api/tools");
    expect(response.status).toBe(200);
    const catalog = (await response.json()).automation;
    const { sessionId, script } = await startChat(chat);
    const offer = chat.app.runner.registry
      .get(sessionId)!
      .policy.offered.tools.find((tool) => tool.name === "automation")!;
    expect(catalog.parameters).toEqual(offer.parameters);
    expect(catalog.description).toBe(offer.description);
    expect(catalog.parameters).toMatchObject({
      properties: {
        action: {
          enum: [
            "list",
            "show",
            "create",
            "update",
            "suspend",
            "resume",
            "run",
          ],
        },
      },
    });
    expect(catalog.parametersHtml).toContain("once");
    expect(catalog.description).toContain(
      "only when the user asks in this chat",
    );
    expect(catalog.tokens).toEqual(
      wireTokens([makeAutomationTool(null, true)]),
    );
    script.reply("Done.");
    await settled(chat, sessionId);
  } finally {
    await chat.app.shutdown();
  }
});
