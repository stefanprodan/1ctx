// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat under test control: the fake fetch answers the catalog as the
// app helper does, and every chat request with a stream the test
// drives frame by frame, holds open, or fails. The frames are in the
// OpenAI shape, so the real wire parses them. chatApp() composes the
// app with it, a provider, an agent and a member, and signs the member
// in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "../../src/server/runner/index.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import { hashPassword } from "../../src/server/users/index.ts";
import { PROVIDER_URL, type TestApp, testApp } from "./app.ts";

export const FLASH = "deepseek/deepseek-v4.1-flash";
// the one catalog model whose row has no tools flag: a send on it is
// offered no tools and behaves as before
export const NO_TOOLS = "deepseek/deepseek-r1-distill-llama-70b";

const catalogBody = () =>
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "providers", "models.json"),
    "utf8",
  );

// one tool call the provider streams, as the OpenAI wire carries it: an
// index, an id, the name and the arguments as one JSON string
export type ToolCallFrame = {
  index?: number;
  id: string;
  name: string;
  arguments: string;
};

// one chat request's stream, as the test drives it
export type Script = {
  body: Record<string, unknown>;
  content(text: string): void;
  reasoning(text: string): void;
  finish(reason?: string): void;
  usage(fields?: { prompt?: number; completion?: number }): void;
  // one tool call delta, in the wire's shape; several with the same
  // index or id accumulate into one call, as a real stream fragments
  toolCall(call: ToolCallFrame): void;
  // a whole round of tool calls: one delta each, then a tool_calls
  // finish and the usage; the stream stays open for the next round the
  // test drives, so end() is left to the caller
  toolRound(
    calls: ToolCallFrame[],
    usage?: {
      prompt?: number;
      completion?: number;
    },
  ): void;
  // close the stream: without a finish the wire reports it ended early
  end(): void;
  // a whole reply: content, finish, usage, end
  reply(text: string): void;
  // true once the runner's abort reached the stream
  aborted: boolean;
};

export type Scripted = {
  fetcher: typeof fetch;
  scripts: Script[];
  // the next script once a chat request arrives
  next(): Promise<Script>;
  // answer every chat request with an HTTP error
  refuse(status: number, body?: string): void;
};

export function scriptedFetch(): Scripted {
  const scripts: Script[] = [];
  const waiting: ((s: Script) => void)[] = [];
  let refusal: { status: number; body: string } | null = null;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${PROVIDER_URL}/models`) {
      return new Response(catalogBody(), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url !== `${PROVIDER_URL}/chat/completions`) {
      throw new TypeError("unable to connect");
    }
    if (refusal !== null) {
      return new Response(refusal.body, { status: refusal.status });
    }
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        script.aborted = true;
      },
    });
    const frame = (chunk: Record<string, unknown>) => {
      try {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      } catch {}
    };
    const script: Script = {
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      aborted: false,
      content: (text) => frame({ choices: [{ delta: { content: text } }] }),
      reasoning: (text) =>
        frame({ choices: [{ delta: { reasoning_content: text } }] }),
      toolCall: (call) =>
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    ...(call.index === undefined ? {} : { index: call.index }),
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      toolRound: (calls, usage = {}) => {
        calls.forEach((call, i) => {
          script.toolCall({ index: call.index ?? i, ...call });
        });
        script.finish("tool_calls");
        script.usage(usage);
      },
      finish: (reason = "stop") =>
        frame({ choices: [{ delta: {}, finish_reason: reason }] }),
      usage: (fields = {}) =>
        frame({
          choices: [],
          usage: {
            prompt_tokens: fields.prompt ?? 10,
            completion_tokens: fields.completion ?? 5,
          },
        }),
      end: () => {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {}
      },
      reply(text) {
        script.content(text);
        script.finish();
        script.usage();
        script.end();
      },
    };
    init?.signal?.addEventListener("abort", () => {
      script.aborted = true;
      try {
        controller.error(new Error("aborted"));
      } catch {}
    });
    scripts.push(script);
    waiting.shift()?.(script);
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    scripts,
    next: () =>
      new Promise<Script>((resolve) => {
        waiting.push(resolve);
      }),
    refuse(status, body = "") {
      refusal = { status, body };
    },
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 5));

// wait until the scripted provider has received at least `count`
// requests and return the last one; a round the runner starts arrives
// as a new script, so a test that drives several rounds waits for each
// by count rather than racing next()
export async function waitScript(
  scripted: Scripted,
  count: number,
  tries = 200,
): Promise<Script> {
  for (let i = 0; i < tries; i++) {
    if (scripted.scripts.length >= count) return scripted.scripts[count - 1]!;
    await tick();
  }
  throw new Error(
    `only ${scripted.scripts.length} chat requests after ${tries} ticks, wanted ${count}`,
  );
}

export type ChatApp = {
  app: TestApp;
  scripted: Scripted;
  admin: ReturnType<TestApp["client"]>;
  member: ReturnType<TestApp["client"]>;
  memberId: string;
  adminId: string;
  // the member's personal project
  projectId: string;
  agentId: string;
  providerId: string;
  // the live secrets object the app reads by name; a test may delete a
  // key to model a search key removed after the policy was built
  secrets: Record<string, string>;
  // make another agent on the same provider, e.g. a no-tools model, and
  // return its id
  makeAgent(fields: { name: string; model: string }): Promise<string>;
};

export async function chatApp(
  options: {
    registry?: Registry;
    // the secrets beside admin.key: a search provider key makes
    // websearch offered (exa.key or firecrawl.key), decision 3
    secrets?: Record<string, string>;
    // the agent's model; the default has the tools flag, so a send on it
    // is offered the built-ins
    model?: string;
    tools?: Tools;
  } = {},
): Promise<ChatApp> {
  const scripted = scriptedFetch();
  const secrets = options.secrets ?? {};
  const app = await testApp({
    fetcher: scripted.fetcher,
    registry: options.registry,
    secrets,
    tools: options.tools,
  });
  const admin = app.client();
  await admin.login("admin", "hunter2-test");
  const { provider } = await (
    await admin.call("POST", "/api/providers", {
      body: {
        name: "local",
        wire: "openai-compatible",
        baseUrl: PROVIDER_URL,
        keyName: null,
      },
    })
  ).json();
  const makeAgent = async (fields: { name: string; model: string }) => {
    const res = await admin.call("POST", "/api/agents", {
      body: {
        name: fields.name,
        providerId: provider.id,
        model: fields.model,
        thinking: null,
        effort: null,
      },
    });
    if (res.status !== 201) {
      throw new Error(
        `agent create answered ${res.status}: ${await res.text()}`,
      );
    }
    const { agent } = await res.json();
    return agent.id as string;
  };
  const agentId = await makeAgent({
    name: "coder",
    model: options.model ?? FLASH,
  });
  const user = app.createUser({
    username: "oana",
    fullName: "Oana Pellea",
    email: "oana@example.com",
    role: "member",
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const member = app.client();
  await member.login("oana", "pw");
  return {
    app,
    scripted,
    admin,
    member,
    memberId: user.id,
    adminId: app.users.byUsername("admin")!.id,
    projectId: app.projects.personal(user.id)!.id,
    agentId,
    providerId: provider.id,
    secrets,
    makeAgent,
  };
}

// a chat started by the member in their personal project; the detail
// and the script driving its reply
export async function startChat(
  chat: ChatApp,
  message = "hello",
  client = chat.member,
  projectId = chat.projectId,
  agentId = chat.agentId,
) {
  const pending = chat.scripted.next();
  const res = await client.call("POST", "/api/sessions", {
    body: { projectId, agentId, message },
  });
  if (res.status !== 201) {
    throw new Error(`start answered ${res.status}: ${await res.text()}`);
  }
  const detail = await res.json();
  const script = await pending;
  return { detail, script, sessionId: detail.session.id as string };
}
