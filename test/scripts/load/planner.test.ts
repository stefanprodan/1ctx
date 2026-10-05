// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { SERVERS, toolDef } from "../../../scripts/load/catalog.ts";
import { dayPlan, offeredOf } from "../../../scripts/load/day.ts";
import {
  capsMode,
  parseCaps,
} from "../../../scripts/load/driver/automations.ts";
import { createMcp } from "../../../scripts/load/fake-mcp.ts";
import {
  createModel,
  kindOf,
  sessionOf,
  turnOf,
} from "../../../scripts/load/fake-model.ts";
import { latencyMs } from "../../../scripts/load/latency.ts";
import { bashPlan } from "../../../scripts/load/turns.ts";

// a request as the server sends it: the tools offered and the messages
function request(text: string, rounds = 0) {
  const tools = [
    ...Object.values(SERVERS).flatMap((s) =>
      s.tools.slice(0, 4).map((t) => {
        const def = toolDef(s.name, t);
        return {
          type: "function",
          function: {
            name: `mcp__${s.name}__${t}`,
            parameters: def.inputSchema,
          },
        };
      }),
    ),
    { type: "function", function: { name: "bash", parameters: {} } },
    {
      type: "function",
      function: {
        name: "memory_edit",
        parameters: {
          properties: { action: { enum: ["set", "delete"] } },
        },
      },
    },
  ];
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "Answer." },
    { role: "user", content: text },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${i}` }],
    });
    messages.push({ role: "tool", content: "ok\nexit 0" });
  }
  return { model: "fake-chat", stream: true, tools, messages };
}

describe("the turn planners", () => {
  test("a bash turn is the same for its key and differs across keys", () => {
    expect(bashPlan("turn 7")).toEqual(bashPlan("turn 7"));
    const shapes = new Set(
      Array.from({ length: 50 }, (_, i) => JSON.stringify(bashPlan(`k${i}`))),
    );
    expect(shapes.size).toBeGreaterThan(40);
  });

  test("bash turns average about four commands", () => {
    let calls = 0;
    for (let i = 0; i < 2000; i++) calls += bashPlan(`turn ${i}`).flat().length;
    const mean = calls / 2000;
    expect(mean).toBeGreaterThan(3.5);
    expect(mean).toBeLessThan(6);
  });

  test("a day turn is the same per marker, kind and tools offered", () => {
    const o = offeredOf(request("#a-1 why"));
    expect(dayPlan("a-1", "chat", o, "a-1")).toEqual(
      dayPlan("a-1", "chat", o, "a-1"),
    );
    const incident = dayPlan("a-1", "incident", o, "a-1");
    expect(incident.rounds.length).toBeGreaterThanOrEqual(7);
    const daily = dayPlan("run-3", "daily", o, "run-3");
    expect(daily.rounds.at(-1)!.calls[0]!.arguments).toContain(
      "/knowledge/reports/run-3.md",
    );
  });

  test("a day turn calls only the tools the request offers", () => {
    const body = request("#b-2 check");
    const offered = new Set(
      body.tools.map((t) => (t.function as { name: string }).name),
    );
    for (let i = 0; i < 30; i++) {
      const plan = dayPlan(`b-${i}`, "chat", offeredOf(body), `b-${i}`);
      for (const call of plan.rounds.flatMap((r) => r.calls)) {
        expect(offered.has(call.name)).toBe(true);
      }
    }
  });

  test("the markers pick the kind and the session", () => {
    expect(kindOf("[incident] #inc-1-3 the 502s")).toBe("incident");
    expect(kindOf("[run] [daily] #run-4 check")).toBe("daily");
    expect(kindOf("[run] [hourly] #run-1 check")).toBe("hourly");
    expect(kindOf("#chat-1 why")).toBe("chat");
    expect(sessionOf("chat-10001-3")).toBe("chat-10001");
    expect(sessionOf("lt-7")).toBe("lt");
  });

  test("the round is the count of tool rounds since the marked message", () => {
    const zero = turnOf(request("#c-1 why"), "day");
    const two = turnOf(request("#c-1 why", 2), "day");
    expect(zero.round).toBe(0);
    expect(two.round).toBe(2);
    expect(two.plan).toEqual(zero.plan);
  });
});

describe("the fake model", () => {
  async function stream(model: ReturnType<typeof createModel>, body: unknown) {
    const res = await model.fetch(
      new Request("http://fake/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const calls = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .flatMap((l) => JSON.parse(l.slice(6)).choices ?? [])
      .flatMap(
        (c: { delta?: { tool_calls?: unknown[] } }) =>
          (c.delta?.tool_calls ?? []) as { function: unknown }[],
      )
      .map((c) => c.function);
    return { text, calls };
  }

  test("streams the same calls for the same marked request", async () => {
    const events: Record<string, unknown>[] = [];
    const model = createModel({ scale: 0, log: (e) => events.push(e) });
    // a key whose turn makes calls
    let key = 0;
    while (
      dayPlan(`d-${key}`, "chat", offeredOf(request("")), `d-${key}`).rounds
        .length === 0
    )
      key++;
    const body = request(`#d-${key} why`);
    const a = await stream(model, body);
    const b = await stream(model, body);
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls).toEqual(a.calls);
    expect(a.text).toContain("data: [DONE]");
    expect(events.filter((e) => e.t === "req")).toHaveLength(2);
    expect(events.find((e) => e.t === "end")?.final).toBe(false);
  });

  test("lists its one model", async () => {
    const res = await createModel().fetch(new Request("http://fake/v1/models"));
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(["fake-chat"]);
  });
});

describe("the latency the fakes share", () => {
  test("the fake MCP sleeps what the fake model planned for the call", async () => {
    const o = offeredOf(request(""));
    const calls = Array.from({ length: 40 }, (_, i) =>
      dayPlan(`m-${i}`, "incident", o, `m-${i}`),
    )
      .flatMap((p) => p.rounds.flatMap((r) => r.calls))
      .filter((c) => c.mcpTool !== null)
      .slice(0, 10);
    expect(calls.length).toBe(10);
    for (const call of calls) {
      const slept: number[] = [];
      const mcp = createMcp({
        sleep: async (ms) => slept.push(ms),
        log: () => {},
      });
      const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(call.mcpTool!)!;
      const res = await mcp.fetch(
        new Request(`http://fake/${server}/mcp`, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool, arguments: JSON.parse(call.arguments) },
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(slept).toEqual([call.mcpMs]);
      expect(call.mcpMs).toBe(latencyMs(tool!, JSON.parse(call.arguments)));
    }
  });

  test("latency spans fast calls and a tail of seconds", () => {
    const ms = Array.from({ length: 4000 }, (_, i) =>
      latencyMs("get_kubernetes_logs", { query: `q${i}` }),
    ).sort((a, b) => a - b);
    expect(ms[2000]!).toBeLessThanOrEqual(60);
    expect(ms[3600]!).toBeGreaterThan(1000);
    expect(ms.at(-1)!).toBeLessThanOrEqual(3000);
  });
});

describe("the step's send caps", () => {
  test("follow the multiple unless --caps holds one mode", () => {
    expect([1, 2, 4, 16].map((mult) => capsMode(mult))).toEqual([
      "default",
      "default",
      "max",
      "max",
    ]);
    expect(
      capsMode(8, parseCaps(["step", "8", "20", "--caps", "default"])),
    ).toBe("default");
    expect(capsMode(1, parseCaps(["--caps", "max", "--incident"]))).toBe("max");
    expect(parseCaps(["step", "1", "20", "--incident"])).toBeUndefined();
    for (const argv of [
      ["--caps", "maximum"],
      ["step", "1", "20", "--caps"],
      ["--caps", "--incident"],
    ]) {
      expect(() => parseCaps(argv)).toThrow("--caps is default or max");
    }
  });
});
