// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The azure wire, for Microsoft Foundry and Azure OpenAI: the Responses
// API, since Azure refuses function tools with thinking on chat
// completions. The body is OpenCode's Responses body, stateless with
// store off, plus the phase Copilot sends back. Stored records are
// projected, never sent as stored: a reasoning item goes back with its
// summary and encrypted blob and no index, one with no blob is left
// out, and a phase record only sets its message's phase. They reach
// only the provider and model that wrote them (the history's lookup).
// The API has no author field, so a named user message opens with the
// author's mark. Two refusals are adapted once each, inside the wire.

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Log } from "../lib/log.ts";
import { markOf } from "./author.ts";
import { errorEvent } from "./azure-stream.ts";
import {
  CatalogError,
  type ChatEvent,
  type ChatMessageIn,
  type ChatRequest,
  type ChatTool,
} from "./types.ts";

const BASE_PATH = "/openai/v1";
// the last api-version that lists deployments with the key; later ones
// moved deployments to the management API, which needs an Entra token
const DEPLOYMENTS_VERSION = "2022-12-01";

export const AZURE_BASE_URL_PROBLEM =
  "must be https://<resource>.services.ai.azure.com/openai/v1 or the same path on <resource>.openai.azure.com";

// null when the base URL is a resource's v1 address, on either host
export function azureBaseUrlProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return AZURE_BASE_URL_PROBLEM;
  }
  return url.protocol === "https:" &&
    url.pathname.replace(/\/+$/, "") === BASE_PATH
    ? null
    : AZURE_BASE_URL_PROBLEM;
}

// both addresses from the one base: chat under it, the deployments
// beside it, outside v1
export function azureUrls(baseUrl: string): { chat: string; catalog: string } {
  const base = baseUrl.replace(/\/+$/, "");
  const root = base.slice(0, base.length - BASE_PATH.length);
  return {
    chat: `${base}/responses?api-version=v1`,
    catalog: `${root}/openai/deployments?api-version=${DEPLOYMENTS_VERSION}`,
  };
}

// strict sent as false always: unset, Azure turns it on and makes every
// property required, so a tool's optional arguments become mandatory
export function responsesTools(tools: readonly ChatTool[]) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export type AzureBodyOptions = {
  // the model refused none, so the least thinking is low
  noneAsLow?: boolean;
  // the provider refused a blob sent back: no reasoning goes this time
  dropReasoning?: boolean;
};

function assistantItems(
  message: Extract<ChatMessageIn, { role: "assistant" }>,
  dropReasoning: boolean,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  let phase: string | undefined;
  for (const record of message.reasoningDetails ?? []) {
    if (record.type === "phase" && typeof record.phase === "string") {
      phase = record.phase;
      continue;
    }
    if (
      record.type !== "reasoning" ||
      dropReasoning ||
      typeof record.encrypted_content !== "string"
    ) {
      continue;
    }
    items.push({
      type: "reasoning",
      summary: Array.isArray(record.summary) ? record.summary : [],
      encrypted_content: record.encrypted_content,
    });
  }
  if (message.content) {
    items.push({
      role: "assistant",
      ...(phase === undefined ? {} : { phase }),
      content: [{ type: "output_text", text: message.content }],
    });
  }
  for (const call of message.toolCalls ?? []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return items;
}

function input(
  messages: readonly ChatMessageIn[],
  dropReasoning: boolean,
): Record<string, unknown>[] {
  return messages.flatMap((message): Record<string, unknown>[] => {
    switch (message.role) {
      case "system":
        return [{ role: "system", content: message.content }];
      case "user": {
        const text = message.name
          ? `${markOf(message.name)}${message.content}`
          : message.content;
        return [{ role: "user", content: [{ type: "input_text", text }] }];
      }
      case "tool":
        return [
          {
            type: "function_call_output",
            call_id: message.toolCallId,
            output: message.content,
          },
        ];
      default:
        return assistantItems(message, dropReasoning);
    }
  });
}

// an effort with its summary; Off and the least thinking as none; the
// default leaves the level to the model and asks only for the summary
function reasoning(req: ChatRequest, noneAsLow: boolean) {
  if (req.thinking && req.reasoningEffort) {
    return { effort: req.reasoningEffort, summary: "auto" };
  }
  if (!req.thinking && (req.thinkingOff || req.least)) {
    return noneAsLow ? { effort: "low", summary: "auto" } : { effort: "none" };
  }
  return { summary: "auto" };
}

export function buildChatBody(
  req: ChatRequest,
  options: AzureBodyOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: input(req.messages, options.dropReasoning ?? false),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: reasoning(req, options.noneAsLow ?? false),
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = responsesTools(req.tools);
  }
  if (req.cacheKey) body.prompt_cache_key = req.cacheKey;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.topP != null) body.top_p = req.topP;
  if (req.maxTokens != null) body.max_output_tokens = req.maxTokens;
  return body;
}

// what a request costs as counted text: the input and the tools as sent,
// a reasoning item by its summary alone, since Azure bills the blob as
// far less than its text
export function countedText(req: ChatRequest): string {
  const items = input(req.messages, false).map((item) => {
    if (item.type !== "reasoning") return item;
    const { encrypted_content: _, ...rest } = item;
    return rest;
  });
  return JSON.stringify({
    input: items,
    tools: responsesTools(req.tools ?? []),
  });
}

// a non-2xx answer in the wire's words, with its code and field
export function azureError(
  event: Extract<ChatEvent, { kind: "error" }>,
): Extract<ChatEvent, { kind: "error" }> {
  const match = /^HTTP (\d+): (.*)$/s.exec(event.message);
  if (!match || event.code !== undefined) return event;
  let parsed: { error?: unknown } | null = null;
  try {
    parsed = JSON.parse(match[2]!);
  } catch {
    return event;
  }
  if (parsed === null || typeof parsed?.error !== "object") return event;
  return {
    ...errorEvent(parsed.error, event.status),
    ...(event.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: event.retryAfterMs }),
  };
}

export type AzureChatDeps = {
  // one request with this body, as the wire streams it
  open(body: Record<string, unknown>): AsyncIterable<ChatEvent>;
  // the provider and model pairs that refused none, kept until a restart
  noneRefused: Set<string>;
  providerId: string;
  providerName: string;
  log?: Log;
};

const sendsReasoning = (body: Record<string, unknown>) =>
  (body.input as Record<string, unknown>[]).some(
    (item) => item.type === "reasoning",
  );

// Before any event reaches the caller, a 400 that refuses none on a
// model that always thinks is sent again at low, remembered per model,
// and one that refuses a blob is sent again without reasoning, after a
// reasoningRefused event. Each at most once, so a round makes at most
// three requests and a second refusal is the round's error.
export async function* azureChat(
  req: ChatRequest,
  deps: AzureChatDeps,
): AsyncIterable<ChatEvent> {
  const memo = `${deps.providerId}\n${req.model}`;
  const fields = { provider: deps.providerName, model: req.model };
  let noneAsLow = deps.noneRefused.has(memo);
  let raised = false;
  let dropReasoning = false;
  while (true) {
    const body = buildChatBody(req, { noneAsLow, dropReasoning });
    let again = false;
    let yielded = false;
    for await (const raw of deps.open(body)) {
      const event = raw.kind === "error" ? azureError(raw) : raw;
      if (!yielded && event.kind === "error" && event.status === 400) {
        if (
          !raised &&
          event.code === "unsupported_value" &&
          event.param === "reasoning.effort" &&
          (body.reasoning as { effort?: string }).effort === "none"
        ) {
          raised = true;
          noneAsLow = true;
          deps.noneRefused.add(memo);
          deps.log?.info("reasoning effort raised", fields);
          again = true;
          break;
        }
        if (
          !dropReasoning &&
          event.code === "invalid_encrypted_content" &&
          sendsReasoning(body)
        ) {
          dropReasoning = true;
          deps.log?.warn("stored reasoning dropped", fields);
          yield { kind: "reasoningRefused" };
          again = true;
          break;
        }
      }
      if (event.kind !== "alive") yielded = true;
      yield event;
    }
    if (!again) return;
  }
}

type Deployment = { id?: unknown; model?: unknown; status?: unknown };

// the deployments a request can name, undescribed: Azure gives no
// window, tools flag or price. The deployed model is kept in listedAs,
// so the catalog finds it in models.dev whatever the deployment is
// named. A further page is an error, never a cut
export function parseDeployments(body: unknown): CatalogMatch[] {
  const list = (body ?? {}) as Record<string, unknown>;
  if (
    list.has_more === true ||
    typeof list.next_link === "string" ||
    typeof list.nextLink === "string"
  ) {
    throw new CatalogError("the deployments list has a further page");
  }
  if (!Array.isArray(list.data)) return [];
  const out: CatalogMatch[] = [];
  const seen = new Set<string>();
  for (const row of list.data as Deployment[]) {
    const id = row?.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    if (row.status !== "succeeded") continue;
    seen.add(id);
    const model = typeof row.model === "string" ? row.model : id;
    out.push({
      id,
      name: model === id ? id : `${id} (${model})`,
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      tools: false,
      reasoning: false,
      thinkingRequired: false,
      reasoningKnown: false,
      described: false,
      listedAs: model,
    });
  }
  return out;
}
