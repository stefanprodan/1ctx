// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fake OpenAI-compatible model, one model, streamed over SSE. A turn
// is keyed by the last user message holding a marker `#<id>` (else by
// its text); its round is the count of tool-call rounds after it. When
// the planned rounds are done the reply streams with no calls.
//
// SHAPE picks the turn:
//   day       (the default) `[incident]` an incident turn, `[run]` with
//             `[hourly]` or `[daily]` a scheduled run, else a chat turn
//             (day.ts), tools chosen from the request's own
//   bash      rounds of bash over the team's docs (turns.ts)
//   text      a text reply; `[tool]` in the message asks one datetime call
//   markdown  MARKDOWN_REPLY cut a word or less at a time, REPEAT times
// bash and text put «<epoch ms>» in every 4th chunk, so a watcher can
// time the relay.
//
// Logs (stdout, JSON lines): `req` per request, `end` when its stream
// ends, each call with its mcpMs (0 for non-MCP tools).
//
// bun scripts/load/fake-model.ts
// env: SHAPE (day), PORT (1241), HOST (127.0.0.1), TIME_SCALE (1),
// REPEAT (1)

import { dayPlan, offeredOf, type Plan } from "./day.ts";
import { MARKDOWN_REPLY } from "./markdown-reply.ts";
import { hash32, rng } from "./random.ts";
import { FAKE, type Kind, TIMING } from "./shapes.ts";
import { bashPlan } from "./turns.ts";

export type Shape = "day" | "bash" | "text" | "markdown";
export const SHAPES: Shape[] = ["day", "bash", "text", "markdown"];

export type ModelOptions = {
  shape?: Shape;
  // scales the first token and the pace; 0 streams at once (tests)
  scale?: number;
  repeat?: number;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
};

type Message = { role: string; content: unknown; tool_calls?: unknown[] };

const WORDS = (
  "the service reads its config from the mounted volume and restarts " +
  "when the checksum changes so a rollout never needs a manual step " +
  "check the logs for the reconcile loop and the controller metrics"
).split(" ");

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const text = (p as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

const MARKER = /#([A-Za-z0-9][A-Za-z0-9-]*)/;

// the last user message with a marker, else the last user message
function anchor(messages: Message[]): { at: number; text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && MARKER.test(textOf(m.content))) {
      return { at: i, text: textOf(m.content) };
    }
  }
  const at = messages.findLastIndex((m) => m.role === "user");
  return { at, text: at === -1 ? "" : textOf(messages[at]!.content) };
}

export function kindOf(text: string): Kind {
  if (text.includes("[incident]")) return "incident";
  if (!text.includes("[run]")) return "chat";
  if (text.includes("[daily]")) return "daily";
  return text.includes("[hourly]") ? "hourly" : "run";
}

// <session>-<turn>: the turn is the last segment when it is a number,
// optionally t-prefixed
export function sessionOf(marker: string): string {
  return /^(.+)-t?\d+$/.exec(marker)?.[1] ?? marker;
}

export type Turn = {
  marker: string;
  kind: Kind;
  round: number;
  key: string;
  plan: Plan;
  // tool results of the last round that exited non-zero
  errors: number;
};

// what the request asks: the turn, its round and the round's calls
export function turnOf(body: Record<string, unknown>, shape: Shape): Turn {
  const messages = (body.messages as Message[] | undefined) ?? [];
  const { at, text } = anchor(messages);
  const marker = MARKER.exec(text)?.[1] ?? "";
  const kind = kindOf(text);
  const since = messages.slice(at + 1);
  const round = since.filter(
    (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
  ).length;
  const last = since.slice(
    since.findLastIndex((m) => m.role === "assistant") + 1,
  );
  const errors = last.filter(
    (m) => m.role === "tool" && /exit [1-9]\d*\s*$/.test(textOf(m.content)),
  ).length;
  const key = marker || `h${hash32(text).toString(36)}`;
  let plan: Plan;
  if (shape === "day") plan = dayPlan(marker, kind, offeredOf(body), key);
  else if (shape === "bash") {
    const rounds = bashPlan(key).map((cmds) => ({
      calls: cmds.map((command) => ({
        name: "bash",
        arguments: JSON.stringify({ command }),
        mcpTool: null,
        mcpMs: 0,
      })),
    }));
    plan = { rounds, reply: TIMING.quickReplyTokens };
  } else if (shape === "text" && text.includes("[tool]")) {
    const args = JSON.stringify({ timezone: "UTC" });
    const call = { name: "datetime", arguments: args, mcpTool: null, mcpMs: 0 };
    plan = { rounds: [{ calls: [call] }], reply: TIMING.quickReplyTokens };
  } else plan = { rounds: [], reply: TIMING.quickReplyTokens };
  return { marker, kind, round, key, plan, errors };
}

const enc = new TextEncoder();

export function createModel(options: ModelOptions = {}) {
  const shape = options.shape ?? "day";
  const scale = options.scale ?? 1;
  const log = options.log ?? ((e) => console.log(JSON.stringify(e)));
  const now = options.now ?? Date.now;
  const pace = TIMING.paceMs * scale;
  const markdown =
    MARKDOWN_REPLY.repeat(options.repeat ?? 1).match(/\s*\S{1,5}|\s+/g) ?? [];
  let streams = 0;

  function stream(body: Record<string, unknown>, signal: AbortSignal) {
    const turn = turnOf(body, shape);
    const { marker, kind, round, key, plan } = turn;
    const calls = plan.rounds[round]?.calls ?? [];
    const wantsTool = calls.length > 0;
    const r = rng(hash32(`${key}\n${round}\nstream`));
    log({
      t: "req",
      at: now(),
      marker,
      kind,
      round,
      session: sessionOf(marker),
      ...(turn.errors > 0 ? { errors: turn.errors } : {}),
    });
    const [workLo, workHi] = TIMING.workTokens;
    const textTokens = wantsTool
      ? workLo + Math.floor(r() * (workHi - workLo))
      : shape === "markdown"
        ? markdown.length
        : plan.reply;
    const promptTokens = Math.ceil(JSON.stringify(body).length / 4);
    const argTokens = calls.reduce(
      (a, c) => a + Math.ceil(c.arguments.length / 4),
      0,
    );
    const completion = textTokens + argTokens;
    const ttft =
      shape === "day"
        ? (kind === "chat" || kind === "incident"
            ? TIMING.firstTokenMs.chat
            : TIMING.firstTokenMs.run) +
          (r() * 2 - 1) * TIMING.firstTokenSpreadMs
        : TIMING.quickFirstTokenMs;
    const relay = shape === "bash" || shape === "text";
    const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
    let timer: ReturnType<typeof setInterval> | null = null;
    let wait: ReturnType<typeof setTimeout> | null = null;
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      streams--;
      if (timer !== null) clearInterval(timer);
      if (wait !== null) clearTimeout(wait);
      timer = null;
      return true;
    };
    const aborted = () =>
      log({
        t: "end",
        at: now(),
        marker,
        round,
        calls: [],
        final: false,
        aborted: true,
      });
    return new ReadableStream<Uint8Array>({
      start(controller) {
        streams++;
        const frame = (chunk: Record<string, unknown>) =>
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(now() / 1000), model: FAKE.model, ...chunk })}\n\n`,
            ),
          );
        const finish = () => {
          if (!close()) return;
          try {
            if (wantsTool) {
              const toolCalls = calls.map((call, index) => ({
                index,
                id: `call_${hash32(`${key}\n${round}\n${index}`).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              }));
              frame({
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: toolCalls },
                    finish_reason: null,
                  },
                ],
              });
            }
            const reason = wantsTool ? "tool_calls" : "stop";
            frame({
              choices: [{ index: 0, delta: {}, finish_reason: reason }],
            });
            frame({
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completion,
                total_tokens: promptTokens + completion,
              },
            });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {}
          log({
            t: "end",
            at: now(),
            marker,
            round,
            calls: calls.map((c) => ({
              tool: c.mcpTool ?? c.name,
              mcpMs: c.mcpMs,
            })),
            final: !wantsTool,
          });
        };
        signal.addEventListener("abort", () => {
          if (close()) aborted();
          try {
            controller.error(new Error("aborted"));
          } catch {}
        });
        const begin = () => {
          wait = null;
          let i = 0;
          try {
            const delta = { role: "assistant", content: "" };
            frame({ choices: [{ index: 0, delta, finish_reason: null }] });
          } catch {}
          timer = setInterval(() => {
            if (i >= textTokens) return finish();
            let text = ` ${WORDS[(i + round) % WORDS.length]}`;
            if (shape === "markdown" && !wantsTool) text = markdown[i] ?? "";
            else if (relay && i % 4 === 0) text += ` «${now()}»`;
            i++;
            try {
              frame({
                choices: [
                  { index: 0, delta: { content: text }, finish_reason: null },
                ],
              });
            } catch {
              close();
            }
          }, pace);
        };
        wait = setTimeout(begin, ttft * scale);
      },
      cancel() {
        if (close()) aborted();
      },
    });
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          {
            id: FAKE.model,
            object: "model",
            name: "Fake Chat",
            context_length: 200_000,
            supported_parameters: ["tools", "tool_choice", "max_tokens"],
            pricing: { prompt: "0.0000001", completion: "0.0000004" },
          },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { error: { message: "invalid JSON" } },
          { status: 400 },
        );
      }
      return new Response(stream(body, req.signal), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    return new Response("not found", { status: 404 });
  }

  return { fetch, streams: () => streams };
}

if (import.meta.main) {
  const shape = (process.env.SHAPE ?? "day") as Shape;
  if (!SHAPES.includes(shape))
    throw new Error(`SHAPE is one of ${SHAPES.join(", ")}`);
  const model = createModel({
    shape,
    scale: Number(process.env.TIME_SCALE ?? 1),
    repeat: Number(process.env.REPEAT ?? 1),
  });
  const port = Number(process.env.PORT ?? FAKE.modelPort);
  Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    idleTimeout: 255,
    fetch: model.fetch,
  });
  console.error(`fake model on ${port}, shape ${shape}`);
}
