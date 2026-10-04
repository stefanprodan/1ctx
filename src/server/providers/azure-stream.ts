// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The azure wire's stream: Responses API events as ChatEvents. Summary
// text is reasoning, with a blank line before each later part or item
// so two summaries never run together. Output text, and a refusal, are
// content. A function call opens with its item, grows by its argument
// deltas and takes the item's whole arguments when it ends, as both
// reference clients do. Each finished reasoning item, and each message's
// phase, is a record kept for the next request to send back. The
// terminal event carries the usage and the finish and ends the read,
// since Responses sends no [DONE].

import { errorStatus, parseFrame } from "./frames.ts";
import type { ChatEvent } from "./types.ts";

const TERMINAL = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// an error body or frame in the wire's words, code first as OpenCode
// words it, with the code and the field it names kept for matching
export function errorEvent(
  error: unknown,
  status?: number,
): Extract<ChatEvent, { kind: "error" }> {
  const fields = (error ?? {}) as Record<string, unknown>;
  const message = text(fields.message) ?? "the provider failed";
  const code =
    typeof fields.code === "number" ? String(fields.code) : text(fields.code);
  const param = text(fields.param);
  const named = status ?? errorStatus(error);
  return {
    kind: "error",
    message: code ? `${code}: ${message}` : message,
    remote: true,
    ...(named === null || named === undefined ? {} : { status: named }),
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  };
}

function terminalEvents(body: any, calls: boolean, refused: boolean) {
  const response = body?.response ?? {};
  if (body.type === "response.failed") {
    return [errorEvent(response.error)];
  }
  const events: ChatEvent[] = [];
  const usage = response.usage;
  if (usage && typeof usage === "object") {
    const cached = usage.input_tokens_details?.cached_tokens;
    const reasoning = usage.output_tokens_details?.reasoning_tokens;
    events.push({
      kind: "usage",
      usage: {
        promptTokens: num(usage.input_tokens),
        completionTokens: num(usage.output_tokens),
        cachedTokens: typeof cached === "number" ? cached : null,
        reasoningTokens: typeof reasoning === "number" ? reasoning : null,
        cost: null,
      },
    });
  }
  const reason = text(response.incomplete_details?.reason);
  const details = refused ? "refusal" : null;
  events.push(
    reason === undefined
      ? { kind: "finish", reason: calls ? "tool_calls" : "stop", details }
      : reason === "max_output_tokens"
        ? { kind: "finish", reason: "length", details }
        : reason === "content_filter"
          ? { kind: "finish", reason: "content_filter", details }
          : { kind: "finish", reason: "stop", details: reason },
  );
  return events;
}

export type AzureStream = {
  map(json: string): ChatEvent[];
  // the terminal event came
  ended(): boolean;
  // a reasoning item is open, which Azure may keep in silence
  thinking(): boolean;
};

export function azureEvents(): AzureStream {
  let ended = false;
  // the summary part the last reasoning came from, so a new one opens
  // with a blank line
  let part: string | null = null;
  let shown = false;
  let partShown = false;
  let calls = false;
  let refused = false;
  // the reasoning items open, by output index: Azure sends nothing while
  // a model reasons with no summary, so the round lifts its idle check
  const thinking = new Set<number>();
  let wasThinking = false;
  // the arguments each open call has built, by output index
  const args = new Map<number, string>();

  const show = (piece: string): ChatEvent[] => {
    if (piece === "") return [];
    const lead = shown && !partShown ? "\n\n" : "";
    shown = true;
    partShown = true;
    return [{ kind: "reasoning", text: `${lead}${piece}` }];
  };

  const reasoning = (body: any): ChatEvent[] => {
    const delta = text(body.delta);
    if (!delta) return [];
    const key = `${body.output_index}:${body.summary_index ?? body.content_index ?? 0}`;
    if (key !== part) {
      part = key;
      partShown = false;
    }
    return show(delta);
  };

  const itemDone = (index: number, item: any): ChatEvent[] => {
    if (item?.type === "function_call") {
      const whole = text(item.arguments);
      if (!args.has(index)) {
        calls = true;
        args.set(index, whole ?? "");
        return [
          {
            kind: "toolCallDelta",
            index,
            ...(text(item.call_id) ? { id: item.call_id } : {}),
            ...(text(item.name) ? { name: item.name } : {}),
            ...(whole ? { arguments: whole } : {}),
          },
        ];
      }
      if (whole === undefined || whole === args.get(index)) return [];
      args.set(index, whole);
      return [{ kind: "toolCallDone", index, arguments: whole }];
    }
    if (item?.type === "reasoning") {
      return [
        {
          kind: "reasoningDetail",
          item: {
            type: "reasoning",
            index,
            summary: Array.isArray(item.summary) ? item.summary : [],
            ...(text(item.encrypted_content)
              ? { encrypted_content: item.encrypted_content }
              : {}),
          },
        },
      ];
    }
    if (item?.type === "message" && text(item.phase)) {
      return [
        {
          kind: "reasoningDetail",
          item: { type: "phase", index, phase: item.phase },
        },
      ];
    }
    return [];
  };

  const map = (json: string): ChatEvent[] => {
    const frame = parseFrame(json);
    if (!frame.ok) return frame.events;
    const events = mapFrame(frame.value);
    const now = thinking.size > 0;
    if (events.length > 0 && now === wasThinking) return events;
    wasThinking = now;
    return [...events, { kind: "alive", thinking: now }];
  };

  const mapFrame = (body: any): ChatEvent[] => {
    const type = body?.type;
    const index =
      typeof body?.output_index === "number" ? body.output_index : 0;
    if (
      type === "response.output_item.added" &&
      body.item?.type === "reasoning"
    ) {
      thinking.add(index);
    }
    if (type === "response.output_item.done" || TERMINAL.has(type)) {
      thinking.delete(index);
      if (TERMINAL.has(type)) thinking.clear();
    }
    return mapType(body);
  };

  const mapType = (body: any): ChatEvent[] => {
    const index =
      typeof body?.output_index === "number" ? body.output_index : 0;
    switch (body?.type) {
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return reasoning(body);
      case "response.output_text.delta":
        return text(body.delta) ? [{ kind: "content", text: body.delta }] : [];
      case "response.refusal.delta":
        if (!text(body.delta)) return [];
        refused = true;
        return [{ kind: "content", text: body.delta }];
      case "response.output_item.added": {
        const item = body.item;
        if (item?.type !== "function_call") return [];
        calls = true;
        const opening = text(item.arguments) ?? "";
        args.set(index, opening);
        return [
          {
            kind: "toolCallDelta",
            index,
            ...(text(item.call_id) ? { id: item.call_id } : {}),
            ...(text(item.name) ? { name: item.name } : {}),
            ...(opening ? { arguments: opening } : {}),
          },
        ];
      }
      case "response.function_call_arguments.delta": {
        const delta = text(body.delta);
        if (!delta) return [];
        args.set(index, (args.get(index) ?? "") + delta);
        return [{ kind: "toolCallDelta", index, arguments: delta }];
      }
      case "response.output_item.done":
        return itemDone(index, body.item);
      case "error":
        return [errorEvent(body)];
      default:
        if (TERMINAL.has(body?.type)) {
          ended = true;
          return terminalEvents(body, calls, refused);
        }
        return [];
    }
  };

  return { map, ended: () => ended, thinking: () => thinking.size > 0 };
}
