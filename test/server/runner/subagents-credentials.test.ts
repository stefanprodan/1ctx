// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's credentials: its bash says each signs reads alone, and
// one that signs only writes refuses rather than going out unsigned.

import { describe, expect, test } from "bun:test";
import type { Script } from "../../helpers/chat.ts";
import { startChat, waitScript } from "../../helpers/chat.ts";
import {
  bashCall,
  delegateCall,
  isChild,
  lastResult,
  settled,
  subagentApp,
} from "../../helpers/subagents.ts";

const QUOTES = "https://quotes.example.test/";
const ORDERS = "https://orders.example.test/";

const bashOf = (script: Script) =>
  (script.body.tools as { function: { name: string; description: string } }[])
    .map((tool) => tool.function)
    .find((tool) => tool.name === "bash")!.description;

describe("a subagent's credentials", () => {
  test("sign reads alone and a write-only one refuses", async () => {
    const chat = await subagentApp({
      secrets: {
        "http-quotes": "quotes-key-0123",
        "http-orders": "orders-key-0123",
      },
    });
    try {
      const created = await chat.admin.call("POST", "/api/projects", {
        body: { name: "finops", description: "A team project." },
      });
      const { project } = await created.json();
      await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
        body: { userId: chat.memberId },
      });
      for (const [name, prefix, methods] of [
        ["quotes", QUOTES, ["GET", "POST"]],
        ["orders", ORDERS, ["POST"]],
      ] as const) {
        const res = await chat.admin.call("POST", "/api/credentials", {
          body: {
            name,
            keyName: `http-${name}`,
            prefix,
            header: "X-Api-Key",
            template: "{key}",
            methods,
            projectIds: [project.id],
          },
        });
        expect(res.status).toBe(201);
      }
      const { script, sessionId } = await startChat(
        chat,
        "hello",
        chat.member,
        project.id,
      );
      expect(bashOf(script)).toContain(`(quotes) is signed in; send no key.`);
      expect(bashOf(script)).toContain(`(orders) is signed in; send no key.`);
      script.toolRound([delegateCall("d1", "Place the order.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      expect(bashOf(child)).toContain(
        "(quotes) is signed in, GET and HEAD only; send no key.",
      );
      expect(bashOf(child)).not.toContain("(orders)");
      child.toolRound([bashCall("c1", `curl -X POST -d '{}' ${ORDERS}new`)]);
      child.end();
      const after = await waitScript(chat.scripted, 3);
      expect(lastResult(after)).toContain(
        "credential orders signs only writes, which a subagent cannot send",
      );
      after.reply("could not");
      (await waitScript(chat.scripted, 4)).reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
