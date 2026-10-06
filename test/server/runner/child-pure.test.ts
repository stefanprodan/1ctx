// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's prompt, result and places, on fixtures.

import { describe, expect, test } from "bun:test";
import { childResult } from "../../../src/server/runner/child-result.ts";
import {
  freeSlot,
  noChildren,
  type SlotPort,
  takeSlot,
} from "../../../src/server/runner/child-slots.ts";
import type { Offered } from "../../../src/server/runner/policy.ts";
import {
  dateLine,
  type PromptPolicy,
  SUBAGENT_LINE,
  subagentPrompt,
  systemPrompt,
} from "../../../src/server/runner/prompt.ts";
import { cutResult } from "../../../src/server/runner/results.ts";
import { makeBashTool } from "../../../src/server/tools/builtin/bash.ts";
import { schema } from "../../../src/server/tools/catalog.ts";
import { tick } from "../../helpers/chat.ts";

const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);

const OFFERED: Offered = {
  tools: [schema(makeBashTool({ subagent: true }))],
  visuals: false,
  knowledge: true,
  search: null,
  skills: { block: "<skills>one</skills>", skills: [] },
  mcp: [],
  mcpPrompt: {
    text: "<mcp_instructions>be kind</mcp_instructions>",
    digest: {},
  },
  mcpCatalog: "<mcp_catalog>x</mcp_catalog>",
  memory: null,
  credentials: [],
  credentialsOff: [],
  web: null,
  subagent: true,
};

const policy: PromptPolicy = {
  prompt: "You write Go.",
  agentName: "coder",
  summoned: null,
  projectName: "ops",
  projectKind: "team",
  projectDescription: "Incidents and pages.",
  fullName: "Casey Doe",
  username: "casey",
  about: "I run clusters.",
  tz: "Europe/Bucharest",
  automation: null,
  offered: OFFERED,
  projectMemory: [{ topic: "deploys", text: "Friday is frozen." }] as never,
  automationMemory: [],
  knowledge: { empty: false },
  disabledCapabilities: ["web", "visualize", "knowledge"],
  mcpOff: ["flux"],
  skillsOff: ["old"],
  subagent: true,
};

describe("a subagent's prompt", () => {
  test("keeps the project, the agent's prompt, its line, the catalogs and the date", () => {
    expect(subagentPrompt(policy, NOW)).toBe(
      [
        "You are coder, an agent in the ops project: Incidents and pages.",
        "You write Go.",
        SUBAGENT_LINE,
        "<skills>one</skills>",
        "<mcp_catalog>x</mcp_catalog>",
        "<mcp_instructions>be kind</mcp_instructions>",
        dateLine(NOW),
      ].join("\n\n"),
    );
  });

  test("is what systemPrompt answers for a subagent, notes and lines left out", () => {
    const prompt = systemPrompt(policy, NOW, "the MCP tools changed", {
      off: ["infra"],
      moved: ["repo infra moved"],
    });
    expect(prompt).toBe(subagentPrompt(policy, NOW));
    expect(prompt).not.toContain("You talk to");
    expect(prompt).not.toContain("Friday is frozen");
    expect(prompt).not.toContain("MCP tools changed");
    expect(prompt).not.toContain("infra");
  });

  test("its bash says nothing of open", () => {
    expect(makeBashTool({ subagent: true }).description).not.toContain(
      "open <file>",
    );
    expect(makeBashTool().description).toContain("open <file>");
  });
});

const end = {
  cause: "finish" as const,
  error: null,
  answer: "the answer",
  last: "the answer",
  folder: "sub-1",
  copied: [] as string[],
  left: [] as string[],
};
const caps = { answerChars: 8000, resultCut: 50_000 };

describe("what a delegate call gives back", () => {
  test("the answer alone when no file came back", () => {
    expect(childResult(end, caps)).toEqual({
      content: "the answer",
      error: false,
    });
  });

  test("the answer cut to the lesser of the two limits", () => {
    const long = { ...end, answer: "a".repeat(20_000) };
    expect(childResult(long, caps).content).toHaveLength(8000);
    expect(
      childResult(long, { answerChars: 8000, resultCut: 1000 }).content,
    ).toHaveLength(1000);
  });

  test("the files as a tail every cut keeps", () => {
    const result = childResult(
      {
        ...end,
        answer: "a".repeat(5000),
        copied: ["/tmp/sub-1/report.md", "/tmp/sub-1/data.json"],
        left: ["big.bin"],
      },
      { answerChars: 8000, resultCut: 1000 },
    );
    expect(result.content.length).toBeLessThanOrEqual(1000);
    const tail = result.content.slice(-result.tail!);
    expect(tail).toBe(
      "\n\nFiles in /tmp/sub-1/:\n/tmp/sub-1/report.md\n/tmp/sub-1/data.json\nNot copied, past this chat's /tmp limits:\nbig.bin",
    );
    const cut = cutResult(result, 600);
    expect(cut.content.endsWith(tail)).toBe(true);
  });

  test("a long list ends in how many more", () => {
    const copied = Array.from(
      { length: 1000 },
      (_, i) => `/tmp/sub-1/file-${i}.txt`,
    );
    const result = childResult({ ...end, copied }, caps);
    const tail = result.content.slice(-result.tail!);
    expect(tail.length).toBeLessThanOrEqual(caps.resultCut / 4);
    expect(tail).toMatch(/and \d+ more in \/tmp\/sub-1\/$/);
  });

  test("a child that failed or ran out is a failed result with its last words", () => {
    expect(
      childResult(
        { ...end, cause: "failure", error: "boom", answer: null, last: "half" },
        caps,
      ),
    ).toEqual({
      content: "The subagent failed: boom. Its last words:\nhalf",
      error: true,
    });
    expect(
      childResult({ ...end, cause: "deadline", answer: null, last: "" }, caps),
    ).toEqual({ content: "The subagent ran out of time.", error: true });
    expect(
      childResult({ ...end, cause: "stop", answer: null, last: "" }, caps)
        .error,
    ).toBe(true);
    expect(childResult({ ...end, answer: " " }, caps)).toEqual({
      content: "The subagent gave no answer. Its last words:\nthe answer",
      error: true,
    });
  });
});

describe("a send's subagent places", () => {
  const port = (room: number) => {
    let extras = 0;
    const freed: number[] = [];
    const slots: SlotPort = {
      atOnce: 2,
      takeExtra: () => {
        if (extras >= room) return false;
        extras++;
        return true;
      },
      freeExtra: () => {
        extras--;
        freed.push(extras);
      },
    };
    return { slots, freed, extras: () => extras };
  };

  test("the first runs in the parent's place, the second takes an extra, the third waits", async () => {
    const children = noChildren();
    const { slots, extras } = port(5);
    const signal = new AbortController().signal;
    const first = takeSlot(children, slots, signal);
    const second = takeSlot(children, slots, signal);
    let third: unknown = "waiting";
    void takeSlot(children, slots, signal).then((slot) => {
      third = slot;
    });
    // taken in the same turn, before any await
    expect(children.running).toBe(2);
    expect(extras()).toBe(1);
    expect(await first).toEqual({ extra: false });
    expect(await second).toEqual({ extra: true });
    await tick();
    expect(third).toBe("waiting");
    freeSlot(children, { extra: false }, slots);
    await tick();
    expect(third).toEqual({ extra: false });
    expect(children.running).toBe(2);
  });

  test("with no extra free the second runs after its sibling", async () => {
    const children = noChildren();
    const { slots } = port(0);
    const signal = new AbortController().signal;
    expect(await takeSlot(children, slots, signal)).toEqual({ extra: false });
    let second: unknown = "waiting";
    void takeSlot(children, slots, signal).then((slot) => {
      second = slot;
    });
    await tick();
    expect(second).toBe("waiting");
    freeSlot(children, { extra: false }, slots);
    await tick();
    expect(second).toEqual({ extra: false });
  });

  test("an abort ends a wait with no place", async () => {
    const children = noChildren();
    const { slots } = port(0);
    const controller = new AbortController();
    await takeSlot(children, slots, controller.signal);
    const waiting = takeSlot(children, slots, controller.signal);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(children.waiting).toEqual([]);
  });
});
