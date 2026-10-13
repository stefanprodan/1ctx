// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Offered, ToolResult } from "../../src/server/tools/index.ts";
import type { Conn, ConnData } from "../../src/server/web/socket.ts";
import type { ToolCall } from "../../src/shared/contracts/tool.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import { ORIGIN } from "./app.ts";
import {
  type ChatApp,
  idle,
  ringing,
  type Script,
  type ToolCallFrame,
} from "./chat.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "socket");

export type FakeConn = Conn & { frames: SocketEvent[]; closed: number[] };

export async function watcher(chat: ChatApp): Promise<FakeConn> {
  const client = chat.member;
  if (client.cookie === null) throw new Error("not signed in");
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: { cookie: client.cookie, host: "1ctx.test", origin: ORIGIN },
  });
  await chat.app.handle(req, "127.0.0.1", (data) => {
    captured = data as ConnData;
    return true;
  });
  if (captured === null) throw new Error("no upgrade data");
  const conn: FakeConn = {
    data: captured,
    frames: [],
    closed: [],
    send(text) {
      conn.frames.push(JSON.parse(text));
      return text.length;
    },
    close(code) {
      conn.closed.push(code ?? 1000);
    },
  };
  chat.app.socket.open(conn);
  return conn;
}

export const watch = (chat: ChatApp, conn: FakeConn, sessionId: string) =>
  chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));

// Generated ids would otherwise change every fixture on every run.
const ID_KEY = /^(id|[a-zA-Z]+Id)$/;
const ID_VALUE = /^[0-9a-z]{12}$/;
function stable(lines: unknown[]): string[] {
  const names = new Map<string, string>();
  const walk = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, null));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    if (
      typeof value === "string" &&
      key !== null &&
      ID_KEY.test(key) &&
      ID_VALUE.test(value)
    ) {
      let name = names.get(value);
      if (name === undefined) {
        name = `id-${String(names.size + 1).padStart(2, "0")}`;
        names.set(value, name);
      }
      return name;
    }
    return value;
  };
  return lines.map((line) => JSON.stringify(walk(line, null)));
}

export function writeLines(name: string, lines: unknown[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${name}.ndjson`), `${stable(lines).join("\n")}\n`);
}

export function write(name: string, first: unknown, conn: FakeConn): void {
  writeLines(name, [first, ...conn.frames.filter((f) => f.type !== "hello")]);
}

export const record = (name: string, detail: unknown, conn: FakeConn) =>
  write(name, { kind: "detail", detail }, conn);

// once every send has ended, a finalize retry's pause rung on the clock
export async function settle(chat: ChatApp) {
  await ringing(chat.app, idle(chat.app), 200);
}

export const call = (
  id: string,
  args: Record<string, unknown> = { timezone: "UTC" },
) => ({
  id,
  name: "datetime",
  arguments: JSON.stringify(args),
});

export type ToolPlan = {
  result?: ToolResult;
  // ends only once the named call has ended, so ends land in an order
  after?: string;
  hang?: boolean;
  onRun?: () => void;
  // reports its result once the abort came
  ignoreAbort?: boolean;
};

type FakeToolsCap = {
  capabilities(): string[];
  serverNames(): string[];
  skillsOff(): string[];
  offered(now: number): Offered;
  run(
    offered: Offered,
    c: ToolCall,
    ctx: { signal: AbortSignal },
  ): Promise<ToolResult>;
};

export function fakeTools(plans: Record<string, ToolPlan>): {
  tools: FakeToolsCap;
  // once the call has started
  ran(id: string): Promise<void>;
} {
  const calls = new Map<
    string,
    { started: PromiseWithResolvers<void>; ended: PromiseWithResolvers<void> }
  >();
  const of = (id: string) => {
    let call = calls.get(id);
    if (call === undefined) {
      call = {
        started: Promise.withResolvers<void>(),
        ended: Promise.withResolvers<void>(),
      };
      calls.set(id, call);
    }
    return call;
  };
  const schemas: Offered["tools"] = [
    {
      name: "datetime",
      description: "the current time",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "webfetch",
      description: "fetch a url",
      parameters: { type: "object", properties: {} },
    },
  ];
  return {
    ran: (id) => of(id).started.promise,
    tools: {
      capabilities: () => [],
      serverNames: () => [],
      skillsOff: () => [],
      offered: () => ({
        tools: schemas,
        visuals: false,
        knowledge: true,
        search: null,
        skills: { block: "", skills: [] },
        mcp: [],
        mcpPrompt: { text: "", digest: {} },
        mcpCatalog: "",
        memory: null,
        credentials: [],
        credentialsOff: [],
        web: null,
      }),
      async run(_offered, c, ctx) {
        const plan = plans[c.id] ?? {
          result: { content: `ran ${c.name}`, error: false },
        };
        const call = of(c.id);
        call.started.resolve();
        try {
          return await outcome(plan, c, ctx);
        } finally {
          call.ended.resolve();
        }
      },
    },
  };

  async function outcome(
    plan: ToolPlan,
    c: ToolCall,
    ctx: { signal: AbortSignal },
  ): Promise<ToolResult> {
    if (plan.hang) {
      // Reject on abort so allSettled releases the send's lock.
      return new Promise<ToolResult>((_resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        ctx.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    }
    if (plan.ignoreAbort) {
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      return plan.result ?? { content: "late result", error: false };
    }
    if (plan.after !== undefined) {
      await of(plan.after).ended.promise;
      // its end written before this one's
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    plan.onRun?.();
    return plan.result ?? { content: `ran ${c.name}`, error: false };
  }
}

export function toolRound(script: Script, calls: ToolCallFrame[]) {
  calls.forEach((c, i) => {
    script.toolCall({ ...c, index: i });
  });
  script.finish("tool_calls");
  script.usage();
  script.end();
}
