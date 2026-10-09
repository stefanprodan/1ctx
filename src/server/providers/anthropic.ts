// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Log } from "../lib/log.ts";
import { errorEvent } from "./anthropic-stream.ts";
import { markOf } from "./author.ts";
import {
  CatalogError,
  type ChatEvent,
  type ChatMessageIn,
  type ChatRequest,
  type ChatTool,
} from "./types.ts";

// Anthropic sizes its output-tokens-per-minute limit from max_tokens at
// the start of a request, so a model's whole 128K may cost 429s on a
// lower tier
export const DEFAULT_MAX_TOKENS = 64_000;
// a round on a model that always thinks pays its thinking from the cap
export const THINKING_MIN_TOKENS = 1024;

type Block = Record<string, unknown>;
type Turn = { role: "user" | "assistant"; content: Block[] };

const EPHEMERAL = { type: "ephemeral" } as const;

export function anthropicTools(tools: readonly ChatTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// what the API requires and does not weigh against the window: the
// least of the round's own cap, the model's and the default
export function maxTokensOf(req: ChatRequest): number {
  let cap = Math.min(
    DEFAULT_MAX_TOKENS,
    req.maxTokens ?? DEFAULT_MAX_TOKENS,
    req.outputLimit ?? DEFAULT_MAX_TOKENS,
  );
  if (req.least && req.thinking) cap = Math.max(cap, THINKING_MIN_TOKENS);
  return Math.max(1, Math.floor(cap));
}

// a history from any provider: ids made of [a-zA-Z0-9_-] and unique in
// the request, each result paired with its call by position as the rows
// pair them, since another provider may repeat an id
function idRewriter() {
  const used = new Set<string>();
  let pending: { from: string; to: string; taken: boolean }[] = [];
  const fresh = (id: string) => {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
    let out = safe;
    for (let n = 2; used.has(out); n++) out = `${safe}_${n}`;
    used.add(out);
    return out;
  };
  return {
    calls(ids: string[]): string[] {
      pending = ids.map((from) => ({ from, to: fresh(from), taken: false }));
      return pending.map((p) => p.to);
    },
    result(id: string): string {
      const call = pending.find((p) => !p.taken && p.from === id);
      if (!call) return fresh(id);
      call.taken = true;
      return call.to;
    },
  };
}

// the arguments as the object tool_use takes; anything else is none
function inputOf(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

// the stored thinking records as blocks; one without its signature
// cannot be replayed and is left out, and the index never goes
function thinkingBlocks(
  message: Extract<ChatMessageIn, { role: "assistant" }>,
  counting: boolean,
): Block[] {
  const out: Block[] = [];
  for (const record of message.reasoningDetails ?? []) {
    if (
      record.type === "thinking" &&
      typeof record.thinking === "string" &&
      typeof record.signature === "string" &&
      record.signature !== ""
    ) {
      out.push(
        counting
          ? { type: "thinking", thinking: record.thinking }
          : {
              type: "thinking",
              thinking: record.thinking,
              signature: record.signature,
            },
      );
    } else if (
      record.type === "redacted_thinking" &&
      typeof record.data === "string"
    ) {
      out.push(
        counting
          ? { type: "redacted_thinking" }
          : { type: "redacted_thinking", data: record.data },
      );
    }
  }
  return out;
}

type BuildOptions = {
  // the provider refused the history: no thinking goes this time
  dropThinking?: boolean;
  // as a fit counts it: no cache marks, a thinking block by its text
  counting?: boolean;
};

function turnsOf(
  messages: readonly ChatMessageIn[],
  options: BuildOptions,
): { system: string; turns: Turn[] } {
  const ids = idRewriter();
  const system: string[] = [];
  const turns: Turn[] = [];
  // consecutive messages of one role are one turn, as the API merges them
  const push = (role: Turn["role"], content: Block[]) => {
    if (content.length === 0) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  };
  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content !== "") system.push(message.content);
        break;
      case "user": {
        const text = message.name
          ? `${markOf(message.name)}${message.content}`
          : message.content;
        push("user", text === "" ? [] : [{ type: "text", text }]);
        break;
      }
      case "tool":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: ids.result(message.toolCallId),
            content: message.content,
            ...(message.failed ? { is_error: true } : {}),
          },
        ]);
        break;
      default: {
        const calls = message.toolCalls ?? [];
        const mapped = ids.calls(calls.map((call) => call.id));
        push("assistant", [
          ...(options.dropThinking
            ? []
            : thinkingBlocks(message, options.counting ?? false)),
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...calls.map((call, i) => ({
            type: "tool_use",
            id: mapped[i],
            name: call.name,
            input: inputOf(call.arguments),
          })),
        ]);
      }
    }
  }
  return { system: system.join("\n\n"), turns };
}

// the last block of each of the last two turns that a mark may sit on:
// text, a call or a result, never thinking. With the system mark, which
// caches the tools before it, three of the four the API allows
function markTail(turns: Turn[]): void {
  for (const turn of turns.slice(-2)) {
    for (let i = turn.content.length - 1; i >= 0; i--) {
      const block = turn.content[i]!;
      if (
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        (block.type === "text" && block.text !== "")
      ) {
        turn.content[i] = { ...block, cache_control: EPHEMERAL };
        break;
      }
    }
  }
}

// an effort, or the model's own level with none; Off and the least
// thinking of a model that can stop are disabled. The default display,
// omitted, would stream empty thinking
function thinking(req: ChatRequest): Record<string, unknown> {
  if (!req.thinking) return { thinking: { type: "disabled" } };
  return {
    thinking: { type: "adaptive", display: "summarized" },
    ...(req.reasoningEffort
      ? { output_config: { effort: req.reasoningEffort } }
      : {}),
  };
}

export function buildChatBody(
  req: ChatRequest,
  options: BuildOptions = {},
): Record<string, unknown> {
  const { system, turns } = turnsOf(req.messages, options);
  if (!options.counting) markTail(turns);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokensOf(req),
  };
  if (system !== "") {
    body.system = [
      {
        type: "text",
        text: system,
        ...(options.counting ? {} : { cache_control: EPHEMERAL }),
      },
    ];
  }
  body.messages = turns;
  if (req.tools && req.tools.length > 0) body.tools = anthropicTools(req.tools);
  Object.assign(body, thinking(req));
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.topP != null) body.top_p = req.topP;
  body.stream = true;
  return body;
}

// a request as counted text: the system, the turns and the tools as
// sent, a thinking block by its text alone, never its signature
export function countedText(req: ChatRequest): string {
  const { system, turns } = turnsOf(req.messages, { counting: true });
  return JSON.stringify({
    system,
    messages: turns,
    tools: anthropicTools(req.tools ?? []),
  });
}

// a refused request's body in the wire's words, its type as the code
export function anthropicError(
  status: number,
  body: string,
): Extract<ChatEvent, { kind: "error" }> | null {
  let parsed: { error?: unknown } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed?.error !== "object") return null;
  return errorEvent(parsed.error, status);
}

const sendsThinking = (body: Record<string, unknown>) =>
  (body.messages as Turn[]).some((turn) =>
    turn.content.some(
      (block) =>
        block.type === "thinking" || block.type === "redacted_thinking",
    ),
  );

export type AnthropicChatDeps = {
  // one request with this body, as the wire streams it
  open(body: Record<string, unknown>): AsyncIterable<ChatEvent>;
  providerName: string;
  log?: Log;
};

// a 400 on a body that carries thinking is sent once more without it,
// before any event: an edited prefix (a summary, the day's date line, an
// answer round's ask) or another organization's key invalidates a
// signature. Only an answered resend forgets the records
export async function* anthropicChat(
  req: ChatRequest,
  deps: AnthropicChatDeps,
): AsyncIterable<ChatEvent> {
  const fields = { provider: deps.providerName, model: req.model };
  const first = buildChatBody(req);
  let yielded = false;
  let refused = false;
  for await (const event of deps.open(first)) {
    if (
      !yielded &&
      event.kind === "error" &&
      event.status === 400 &&
      event.code === "invalid_request_error" &&
      sendsThinking(first)
    ) {
      refused = true;
      break;
    }
    if (event.kind !== "alive") yielded = true;
    yield event;
  }
  if (!refused) return;
  let answered = false;
  for await (const event of deps.open(
    buildChatBody(req, { dropThinking: true }),
  )) {
    if (!answered && event.kind !== "error") {
      answered = true;
      deps.log?.warn("stored reasoning dropped", fields);
      yield { kind: "reasoningRefused" };
    }
    answered = true;
    yield event;
  }
}

type Model = {
  id?: unknown;
  display_name?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  capabilities?: {
    thinking?: {
      types?: Record<string, { supported?: unknown } | undefined>;
    };
  };
};

const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

// the models with their window, output cap and thinking. A model that
// cannot take disabled always thinks; one with no adaptive (the 4.5
// models) runs with thinking off, since budget thinking is not sent. A
// further page is an error, never a cut
export function parseModels(body: unknown): CatalogMatch[] {
  const list = (body ?? {}) as Record<string, unknown>;
  if (list.has_more === true) {
    throw new CatalogError("the model list has a further page");
  }
  if (!Array.isArray(list.data)) return [];
  const out: CatalogMatch[] = [];
  const seen = new Set<string>();
  for (const row of list.data as Model[]) {
    const id = row?.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const types = row.capabilities?.thinking?.types;
    const known = types !== null && typeof types === "object";
    const contextLength = positive(row.max_input_tokens);
    const outputLimit = positive(row.max_tokens);
    out.push({
      id,
      name:
        typeof row.display_name === "string" && row.display_name !== ""
          ? row.display_name
          : id,
      contextLength,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: known && types.adaptive?.supported === true,
      thinkingRequired: known && types.disabled?.supported === false,
      reasoningKnown: known,
      described: contextLength !== null || known,
      listedAs: id,
      ...(outputLimit === null ? {} : { outputLimit }),
    });
  }
  return out;
}
