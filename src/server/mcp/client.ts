// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The official SDK owns JSON-RPC, version negotiation, SSE and sessions.
// This is its only importer and keeps every response under one byte budget.

import {
  Client,
  type JsonSchemaType,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { CLIENT_CLEANUP_MS, MAX_ERROR } from "./limits.ts";
import type { McpResult } from "./result.ts";

export type Fetcher = typeof fetch;

export type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
};

export type ClientInfo = {
  serverName: string;
  serverVersion: string;
  instructions: string;
  protocolEra: "modern" | "legacy" | "";
  protocolVersion: string;
};

export type ClientView = {
  listTools(): Promise<{ tools: ListedTool[] }>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    definition: ListedTool,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpResult>;
  info(): ClientInfo;
};

export type ClientOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  bodyBytes: number;
};

const argumentValidator = new AjvJsonSchemaValidator();

export function validateArguments(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null {
  try {
    const validate = argumentValidator.getValidator<Record<string, unknown>>(
      schema as JsonSchemaType,
    );
    const result = validate(input);
    if (result.valid) return null;
    return result.errorMessage.split(",")[0]?.trim() || "arguments are invalid";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return [...text].slice(0, max).join("");
}

function scrubText(text: string, key: string | null): string {
  return key === null || key === "" ? text : text.replaceAll(key, "[redacted]");
}

export function scrub<T>(value: T, key: string | null): T {
  if (typeof value === "string") return scrubText(value, key) as T;
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, key)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      out[scrubText(name, key)] = scrub(item, key);
    }
    return out as T;
  }
  return value;
}

type Budget = {
  limit: number;
  remaining: number;
  over: boolean;
  // ends the transport: an SSE request the SDK waits on is not tied to
  // the fetch's signal, so without this it would hold until the deadline
  close: () => void;
};

function budgetWords(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

function overBudget(budget: Budget, controller: AbortController): never {
  budget.over = true;
  controller.abort(new Error("MCP response byte budget exceeded"));
  budget.close();
  throw new Error("MCP response byte budget exceeded");
}

function consume(
  budget: Budget,
  bytes: number,
  controller: AbortController,
): void {
  if (bytes > budget.remaining) overBudget(budget, controller);
  budget.remaining -= bytes;
}

function countedBody(
  body: ReadableStream<Uint8Array>,
  budget: Budget,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await reader.read();
        if (next.done) {
          stream.close();
          return;
        }
        consume(budget, next.value.byteLength, controller);
        stream.enqueue(next.value);
      } catch (error) {
        // the source stops too, so nothing keeps reading a body over
        // the budget
        void reader.cancel(error).catch(() => undefined);
        stream.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function errorBody(
  response: Response,
  budget: Budget,
  controller: AbortController,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    consume(budget, next.value.byteLength, controller);
    chunks.push(next.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function requestSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
  controller: AbortController,
): AbortSignal {
  const signals = [controller.signal];
  if (init?.signal) signals.push(init.signal);
  if (input instanceof Request) signals.push(input.signal);
  return AbortSignal.any(signals);
}

function responseHeaders(headers: Headers, key: string | null): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (key !== null && key !== "" && name.includes(key)) continue;
    out.append(name, scrubText(value, key));
  }
  return out;
}

function budgetedFetch(
  fetcher: Fetcher,
  budget: Budget,
  key: string | null,
): Fetcher {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    const response = await fetcher(input, {
      ...init,
      signal: requestSignal(input, init, controller),
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > budget.remaining) {
      void response.body?.cancel();
      overBudget(budget, controller);
    }
    const headers = responseHeaders(response.headers, key);
    if (!response.ok) {
      const bytes = await errorBody(response, budget, controller);
      const text = scrubText(new TextDecoder().decode(bytes), key);
      headers.delete("content-length");
      return new Response(text, {
        status: response.status,
        statusText: scrubText(response.statusText, key),
        headers,
      });
    }
    return new Response(
      response.body === null
        ? null
        : countedBody(response.body, budget, controller),
      {
        status: response.status,
        statusText: scrubText(response.statusText, key),
        headers,
      },
    );
  }) as Fetcher;
}

// a request that never reached the server: the runtime's fetch failure,
// wrapped by the SDK in its probe or request error, whose words name
// the computer and the url and help nobody
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

export function connectionFailed(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_CODES.has(code)) return true;
    if (
      /unable to connect|fetch failed|failed to fetch/i.test(current.message)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function errorText(error: unknown, key: string | null, budget: Budget): string {
  if (budget.over) {
    return `the MCP server's answer is over ${budgetWords(budget.limit)}`;
  }
  let text: string;
  if (
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401)
  ) {
    text = "the MCP server refused the key";
  } else if (connectionFailed(error)) {
    text = "the MCP server is offline";
  } else if (error instanceof SdkHttpError) {
    text = `the MCP server answered ${error.status}: ${error.message}`;
  } else if (
    error instanceof SdkError &&
    error.code === SdkErrorCode.RequestTimeout
  ) {
    text = "MCP request timed out";
  } else if (error instanceof ProtocolError || error instanceof SdkError) {
    text = error.message;
  } else {
    text = error instanceof Error ? error.message : String(error);
  }
  return cut(scrubText(text, key), MAX_ERROR);
}

async function cleanup(
  client: Client,
  transport: StreamableHTTPClientTransport,
  deadline: number,
): Promise<void> {
  const remaining = Math.max(0, deadline - Date.now());
  const timeoutMs = Math.min(CLIENT_CLEANUP_MS, remaining);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = (async () => {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  })();
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        void transport.close().catch(() => undefined);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function remaining(deadline: number, signal: AbortSignal): number {
  signal.throwIfAborted();
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("MCP request timed out");
  return timeoutMs;
}

export async function withClient<T>(
  deps: { fetcher: Fetcher; version: string },
  server: { url: string },
  key: string | null,
  options: ClientOptions,
  fn: (client: ClientView) => Promise<T>,
): Promise<T> {
  const budget: Budget = {
    limit: options.bodyBytes,
    remaining: options.bodyBytes,
    over: false,
    close: () => {
      void transport.close().catch(() => undefined);
    },
  };
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: budgetedFetch(deps.fetcher, budget, key),
    requestInit: {
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
    },
  });
  const client = new Client(
    { name: "1ctx", version: deps.version },
    {
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    },
  );
  const deadline = Date.now() + options.timeoutMs;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("MCP request timed out")),
    options.timeoutMs,
  );
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const close = () => {
    void transport.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close);
  if (signal.aborted) close();
  let value: T | undefined;
  let failure: unknown;
  try {
    await client.connect(transport, {
      signal,
      timeout: remaining(deadline, signal),
    });
    const view: ClientView = {
      listTools: () =>
        client.listTools(undefined, {
          signal,
          timeout: remaining(deadline, signal),
        }) as Promise<{ tools: ListedTool[] }>,
      callTool: async (name, args, definition, callOptions) => {
        const callSignal = AbortSignal.any([signal, callOptions.signal]);
        return (await client.callTool(
          { name, arguments: args },
          {
            signal: callSignal,
            timeout: Math.min(
              callOptions.timeoutMs,
              remaining(deadline, callSignal),
            ),
            toolDefinition: definition as Tool,
          },
        )) as McpResult;
      },
      info: () => {
        const serverVersion = client.getServerVersion();
        return {
          serverName: serverVersion?.name ?? "",
          serverVersion: serverVersion?.version ?? "",
          instructions: client.getInstructions() ?? "",
          protocolEra: client.getProtocolEra() ?? "",
          protocolVersion:
            transport.protocolVersion ??
            client.getNegotiatedProtocolVersion() ??
            "",
        };
      },
    };
    value = await fn(view);
  } catch (error) {
    failure = error;
  } finally {
    await cleanup(client, transport, deadline);
    signal.removeEventListener("abort", close);
    clearTimeout(timer);
  }
  if (budget.over || failure !== undefined) {
    throw new Error(errorText(failure, key, budget));
  }
  return value as T;
}
