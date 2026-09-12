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
import { hashPassword } from "../../src/server/users/index.ts";
import { PROVIDER_URL, type TestApp, testApp } from "./app.ts";

export const FLASH = "deepseek/deepseek-v4.1-flash";

const catalogBody = () =>
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "providers", "models.json"),
    "utf8",
  );

// one chat request's stream, as the test drives it
export type Script = {
  body: Record<string, unknown>;
  content(text: string): void;
  reasoning(text: string): void;
  finish(reason?: string): void;
  usage(fields?: { prompt?: number; completion?: number }): void;
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
};

export async function chatApp(
  options: { registry?: Registry } = {},
): Promise<ChatApp> {
  const scripted = scriptedFetch();
  const app = await testApp({
    fetcher: scripted.fetcher,
    registry: options.registry,
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
  const { agent } = await (
    await admin.call("POST", "/api/agents", {
      body: { name: "coder", providerId: provider.id, model: FLASH },
    })
  ).json();
  const user = app.createUser({
    username: "oana",
    fullName: "Oana Pellea",
    role: "member",
    passwordHash: await hashPassword("pw"),
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
    agentId: agent.id,
    providerId: provider.id,
  };
}

// a chat started by the member in their personal project; the detail
// and the script driving its reply
export async function startChat(
  chat: ChatApp,
  message = "hello",
  client = chat.member,
  projectId = chat.projectId,
) {
  const pending = chat.scripted.next();
  const res = await client.call("POST", "/api/sessions", {
    body: { projectId, agentId: chat.agentId, message },
  });
  if (res.status !== 201) {
    throw new Error(`start answered ${res.status}: ${await res.text()}`);
  }
  const detail = await res.json();
  const script = await pending;
  return { detail, script, sessionId: detail.session.id as string };
}
