// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat under test control: the fake fetch answers the catalog as the
// app helper does, and every chat request with a stream the test
// drives frame by frame, holds open, or fails. The frames are in the
// OpenAI shape, or the Messages shape on anthropic, so the real wire
// parses them. chatApp() composes the
// app with it, a provider, an agent and a member, and signs the member
// in.

import type { Db } from "../../src/server/db/index.ts";
import type { LogFactory } from "../../src/server/lib/log.ts";
import { tokens } from "../../src/server/lib/tokens.ts";
import { DEFAULT_LIMITS, type Limits } from "../../src/server/limits/index.ts";
import type { JobRunner } from "../../src/server/repos/index.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import type { Wire } from "../../src/shared/words.ts";
import {
  ANTHROPIC_CHAT,
  ANTHROPIC_MODELS,
  ANTHROPIC_URL,
  AZURE_URL,
  fakeFetch,
  GEMINI_URL,
  hashPassword,
  PROVIDER_URL,
  type TestApp,
  testApp,
} from "./app.ts";

export const FLASH = "deepseek/deepseek-v4.1-flash";
export const GEMINI_FLASH = "gemini-3.8-flash";
// a deployment the azure recording lists, undescribed, so the agent
// states its window and tools
export const AZURE_MODEL = "gpt-6-luna";
// a model the anthropic catalog describes, which can stop thinking
export const ANTHROPIC_MODEL = "claude-haiku-5-5";
// the one catalog model whose row has no tools flag: a send on it is
// offered no tools and behaves as before
export const NO_TOOLS = "deepseek/deepseek-r1-distill-llama-70b";

// one tool call the provider streams, as the OpenAI wire carries it: an
// index, an id, the name and the arguments as one JSON string
export type ToolCallFrame = {
  index?: number;
  id?: string;
  name?: string;
  arguments: string;
  signature?: string;
};

// one chat request's stream, as the test drives it
export type Script = {
  body: Record<string, unknown>;
  // the request's headers, names lowercased
  headers: Record<string, string>;
  sse(text: string): void;
  content(text: string): void;
  reasoning(text: string): void;
  finish(reason?: string): void;
  usage(fields?: {
    prompt?: number;
    completion?: number;
    cached?: number;
  }): void;
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
      cached?: number;
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
  requests: { inputTokens: number; maxTokens: number; accepted: boolean }[];
  // the next script once a chat request arrives
  next(): Promise<Script>;
  // answer every chat request with an HTTP error, or only the next
  // `times`, with the headers given
  refuse(
    status: number,
    body?: string,
    options?: { times?: number; headers?: Record<string, string> },
  ): void;
  // fail the next `count` chat requests before any response, as a reset
  // connection or a headers timeout does
  drop(count: number): void;
  // the chat requests made, the dropped ones included
  chats(): number;
};

// the Messages frames for the script's calls: a block opened on its first
// piece, a thinking block closed when another starts, the OpenAI finish
// words in Anthropic's
const STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

function messagesFrames(frame: (chunk: Record<string, unknown>) => void) {
  let blocks = 0;
  let text: number | null = null;
  let thinking: number | null = null;
  const tools = new Map<number | string, number>();
  let lastTool: number | string = 0;
  const open = (block: Record<string, unknown>) => {
    if (thinking !== null) {
      frame({ type: "content_block_stop", index: thinking });
      thinking = null;
    }
    const index = blocks++;
    frame({ type: "content_block_start", index, content_block: block });
    return index;
  };
  const delta = (index: number, delta: Record<string, unknown>) =>
    frame({ type: "content_block_delta", index, delta });
  return {
    content(piece: string) {
      if (text === null) text = open({ type: "text", text: "" });
      delta(text, { type: "text_delta", text: piece });
    },
    reasoning(piece: string) {
      if (thinking === null) {
        const index = open({ type: "thinking", thinking: "", signature: "" });
        thinking = index;
      }
      delta(thinking, { type: "thinking_delta", thinking: piece });
    },
    toolCall(call: ToolCallFrame) {
      const key = call.index ?? call.id ?? lastTool;
      lastTool = key;
      let index = tools.get(key);
      if (index === undefined) {
        index = open({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        });
        tools.set(key, index);
      }
      if (call.arguments) {
        delta(index, {
          type: "input_json_delta",
          partial_json: call.arguments,
        });
      }
    },
    finish(reason: string) {
      if (thinking !== null) {
        frame({ type: "content_block_stop", index: thinking });
        thinking = null;
      }
      frame({
        type: "message_delta",
        delta: { stop_reason: STOP_REASONS[reason] ?? reason },
      });
    },
    usage(fields: { prompt?: number; completion?: number; cached?: number }) {
      const prompt = fields.prompt ?? 10;
      frame({
        type: "message_delta",
        delta: {},
        usage: {
          input_tokens: prompt - (fields.cached ?? 0),
          cache_read_input_tokens: fields.cached ?? 0,
          cache_creation_input_tokens: 0,
          output_tokens: fields.completion ?? 5,
        },
      });
    },
  };
}

export function scriptedFetch(
  fallback?: typeof fetch,
  window?: number,
): Scripted {
  const catalog = fakeFetch().fetcher;
  const scripts: Script[] = [];
  const requests: Scripted["requests"] = [];
  const waiting: ((s: Script) => void)[] = [];
  let refusal: {
    status: number;
    body: string;
    times: number;
    headers: Record<string, string>;
  } | null = null;
  let dropping = 0;
  let chats = 0;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (
      url === `${PROVIDER_URL}/models` ||
      url === `${GEMINI_URL}/models?pageSize=1000` ||
      url === ANTHROPIC_MODELS
    ) {
      return catalog(input, init);
    }
    const gemini = url === `${GEMINI_URL}/openai/chat/completions`;
    // a test that brings its own fetch answers the Messages address with
    // recordings (helpers/anthropic.ts); others drive it frame by frame
    const anthropic = url === ANTHROPIC_CHAT && fallback === undefined;
    if (!gemini && !anthropic && url !== `${PROVIDER_URL}/chat/completions`) {
      if (fallback !== undefined) return fallback(input, init);
      throw new TypeError("unable to connect");
    }
    chats++;
    if (dropping > 0) {
      dropping--;
      throw new TypeError("the connection was reset");
    }
    if (refusal !== null) {
      const { status, body, headers } = refusal;
      if (--refusal.times <= 0) refusal = null;
      return new Response(body, { status, headers });
    }
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    if (window !== undefined) {
      const inputTokens = tokens(
        JSON.stringify({ messages: body.messages, tools: body.tools ?? [] }),
      );
      const maxTokens =
        typeof body.max_tokens === "number" ? body.max_tokens : 0;
      const accepted = inputTokens + maxTokens <= window;
      requests.push({ inputTokens, maxTokens, accepted });
      if (!accepted) {
        return Response.json(
          { error: { message: "input plus max_tokens exceeds the window" } },
          { status: 400 },
        );
      }
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
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const messages = anthropic ? messagesFrames(frame) : null;
    const script: Script = {
      body,
      headers,
      sse(text) {
        controller.enqueue(encoder.encode(text));
      },
      aborted: false,
      content: (text) =>
        messages
          ? messages.content(text)
          : frame({ choices: [{ delta: { content: text } }] }),
      reasoning: (text) =>
        messages
          ? messages.reasoning(text)
          : frame({
              choices: [
                {
                  delta: gemini
                    ? {
                        content: text,
                        extra_content: { google: { thought: true } },
                      }
                    : { reasoning_content: text },
                },
              ],
            }),
      toolCall: (call) =>
        messages
          ? messages.toolCall(call)
          : frame({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        ...(call.index === undefined
                          ? {}
                          : { index: call.index }),
                        id: call.id,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: call.arguments,
                        },
                        ...(call.signature === undefined
                          ? {}
                          : {
                              extra_content: {
                                google: { thought_signature: call.signature },
                              },
                            }),
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
        messages
          ? messages.finish(reason)
          : frame({ choices: [{ delta: {}, finish_reason: reason }] }),
      usage: (fields = {}) =>
        messages
          ? messages.usage(fields)
          : frame({
              choices: [],
              usage: {
                prompt_tokens: fields.prompt ?? 10,
                completion_tokens: fields.completion ?? 5,
                total_tokens: (fields.prompt ?? 10) + (fields.completion ?? 5),
                ...(fields.cached === undefined
                  ? {}
                  : {
                      prompt_tokens_details: { cached_tokens: fields.cached },
                    }),
              },
            }),
      end: () => {
        try {
          if (messages) frame({ type: "message_stop" });
          else controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
    requests,
    next: () =>
      new Promise<Script>((resolve) => {
        waiting.push(resolve);
      }),
    refuse(status, body = "", options = {}) {
      refusal = {
        status,
        body,
        times: options.times ?? Number.POSITIVE_INFINITY,
        headers: options.headers ?? {},
      };
    },
    drop(count) {
      dropping = count;
    },
    chats: () => chats,
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 5));

// wait until the scripted provider has received at least `count`
// requests and return the last one; a round the runner starts arrives
// as a new script, so a test that drives several rounds waits for each
// by count rather than racing next(). Up to 4 s, under a test's 5 s:
// each bash command starts a worker, slower on a CI runner
export async function waitScript(
  scripted: Scripted,
  count: number,
  tries = 800,
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

export async function setLimits(chat: ChatApp, values: Partial<Limits>) {
  const response = await chat.admin.call("PUT", "/api/limits", {
    body: { values: { ...DEFAULT_LIMITS, ...values } },
  });
  if (response.status !== 200) {
    throw new Error(
      `limits save answered ${response.status}: ${await response.text()}`,
    );
  }
}

export async function chatApp(
  options: {
    // the secrets beside user-admin.key: a search provider key makes
    // websearch offered (search-exa.key or search-firecrawl.key), decision 3
    secrets?: Record<string, string>;
    // the agent's model; the default has the tools flag, so a send on it
    // is offered the built-ins
    model?: string;
    wire?: Wire;
    tools?: Tools;
    fetcher?: typeof fetch;
    logFactory?: LogFactory;
    // a command worker other than the real one
    commandWorker?: URL;
    window?: number;
    // a file the test reopens, for a restart over the same rows
    db?: Db;
    drainMs?: number;
    // the repositories' cache and their fetches; none fetches nothing
    cacheDir?: string;
    repoJobs?: JobRunner;
  } = {},
): Promise<ChatApp> {
  const scripted = scriptedFetch(options.fetcher, options.window);
  const secrets = options.secrets ?? {};
  const app = await testApp({
    fetcher: scripted.fetcher,
    logFactory: options.logFactory,
    secrets,
    tools: options.tools,
    db: options.db,
    drainMs: options.drainMs,
    ...(options.commandWorker ? { commandWorker: options.commandWorker } : {}),
    cacheDir: options.cacheDir,
    repoJobs: options.repoJobs,
  });
  const admin = app.client();
  await admin.login("admin", "hunter2-test");
  const { provider } = await (
    await admin.call("POST", "/api/providers", {
      body: {
        name: "local",
        wire: options.wire ?? "openai-compatible",
        baseUrl:
          options.wire === "gemini"
            ? GEMINI_URL
            : options.wire === "azure"
              ? AZURE_URL
              : options.wire === "anthropic"
                ? ANTHROPIC_URL
                : PROVIDER_URL,
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
        servers: [],
        mcpMode: "auto",
        ...(options.wire === "azure"
          ? { contextLength: options.window ?? 400_000, tools: true }
          : {}),
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
    model:
      options.model ??
      (options.wire === "gemini"
        ? GEMINI_FLASH
        : options.wire === "azure"
          ? AZURE_MODEL
          : options.wire === "anthropic"
            ? ANTHROPIC_MODEL
            : FLASH),
  });
  if (options.window !== undefined) {
    app.db
      .query("update agents set context_length = ? where id = ?")
      .run(options.window, agentId);
  }
  const user = app.createUser({
    username: "casey",
    fullName: "Casey Doe",
    email: "casey@example.com",
    role: "member",
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const member = app.client();
  await member.login("casey", "pw");
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
