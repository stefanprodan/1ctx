// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Recorded-shaped calls use each adapter's envelope. The delta variants
// exercise fragmentation without claiming that every upstream streams it.

import { describe, expect, test } from "bun:test";
import { VISUAL_EVERY_MS } from "../../../src/server/runner/round-visuals.ts";
import type { Wire } from "../../../src/shared/words.ts";
import { chatApp, startChat, tick, waitScript } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

const html = '<svg viewBox="0 0 680 80"><text x="20" y="40">Hello</text></svg>';
const wires: { wire: Wire; directory: string }[] = [
  { wire: "openai-compatible", directory: "openai" },
  { wire: "openrouter", directory: "openrouter" },
  { wire: "gemini", directory: "gemini" },
];

describe("visual provider frames through the composed runner", () => {
  for (const { wire, directory } of wires) {
    for (const deltas of [false, true]) {
      test(`${wire} ${deltas ? "argument deltas" : "whole arguments"}`, async () => {
        const fixture = await Bun.file(
          new URL(
            `../../fixtures/providers/${directory}/chat-visualize${deltas ? "-deltas" : ""}.sse`,
            import.meta.url,
          ),
        ).text();
        const chat = await chatApp({ wire });
        try {
          const { script, sessionId, detail } = await startChat(chat);
          const conn = await watcher(chat);
          watch(chat, conn, sessionId);
          for (const frame of fixture.trimEnd().split("\n\n")) {
            script.sse(`${frame}\n\n`);
            await tick();
            chat.app.now.value += VISUAL_EVERY_MS;
            await tick();
          }
          const answer = await waitScript(chat.scripted, 2);
          const stored = chat.app.sessions.message(detail.messages[1].id)!;
          expect(stored.toolCalls).toEqual([
            {
              id: "call_visual",
              name: "visualize",
              arguments: JSON.stringify({ title: "Greeting", html }),
              ...(wire === "gemini" ? { signature: "visual-signature" } : {}),
            },
          ]);
          const visualFrames = frames(conn, "visual");
          expect(visualFrames.length).toBe(deltas ? 3 : 0);
          let prefix = "";
          for (const visual of visualFrames) {
            expect(visual.callIndex).toBe(0);
            expect(visual.htmlAt).toBe(prefix.length);
            prefix += visual.html;
            expect(html.startsWith(prefix)).toBe(true);
          }
          if (deltas) expect(prefix).toBe(html);
          expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
          const res = await chat.member.call(
            "GET",
            `/api/sessions/${sessionId}/messages/${stored.id}/calls/0/visual`,
          );
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ title: "Greeting", html });
          expect(JSON.stringify(answer.body.messages)).toContain(
            JSON.stringify({ title: "Greeting", html })
              .replaceAll("\\", "\\\\")
              .replaceAll('"', '\\"'),
          );
          if (wire === "gemini") {
            expect(JSON.stringify(answer.body.messages)).toContain(
              "visual-signature",
            );
          }
          answer.reply("Done.");
        } finally {
          await chat.app.shutdown();
        }
      });
    }
  }
});
