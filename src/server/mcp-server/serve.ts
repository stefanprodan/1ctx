// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  createMcpHandler,
  fromJsonSchema,
  type jsonSchemaValidator,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import { MAX_EDITS } from "../knowledge/index.ts";
import { HttpError } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { errorFields, type LogFields } from "../lib/log.ts";
import { knowledgeTool } from "./knowledge.ts";
import { parseKnowledge, parseProjects, parseSessions } from "./parse.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";
import { projectsTool } from "./projects.ts";
import { errorResult, type McpResult } from "./result.ts";
import { sessionsTool } from "./sessions.ts";

const permissive = {
  getValidator: () => (input: unknown) => ({
    valid: true as const,
    data: input,
    errorMessage: undefined,
  }),
} as unknown as jsonSchemaValidator;

const readProperties = {
  action: { type: "string" },
  projectId: { type: "string" },
  after: { type: ["string", "null"] },
  stamp: { type: ["string", "null"] },
  prefix: { type: ["string", "null"] },
  since: { type: ["string", "null"], format: "date-time" },
  readAt: { type: ["string", "null"], format: "date-time" },
  q: { type: "string" },
  skip: { type: "integer", minimum: 0 },
  fileId: { type: "string" },
  versionId: { type: "string" },
  revision: { type: ["integer", "null"], minimum: 1 },
  offset: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1 },
  outline: { type: "boolean" },
};

const changeProperties = {
  revision: { type: "integer", minimum: 1 },
  name: { type: "string" },
  text: { type: "string" },
  edits: {
    type: "array",
    maxItems: MAX_EDITS,
    items: {
      type: "object",
      properties: { old: { type: "string" }, new: { type: "string" } },
      required: ["old", "new"],
      additionalProperties: false,
    },
  },
};

const schema = (
  actions: readonly string[],
  properties: Record<string, unknown>,
) =>
  fromJsonSchema<Record<string, unknown>>(
    {
      type: "object",
      properties: {
        ...properties,
        action: { type: "string", enum: [...actions] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permissive,
  );

const READ_ACTIONS = ["list", "search", "read", "versions", "version"];
const WRITE_ACTIONS = ["create", "edit", "replace", "rename", "delete"];

const READ_DESCRIPTION =
  "List uses projectId, optional folder prefix and optional ISO 8601 since, then after, stamp and readAt to continue. Search uses projectId and q, optional fileId for every hit line in one file, then after and skip from the footer. A match needs every word; double quotes make a phrase. Read uses projectId and fileId, optional offset and limit for lines, or outline=true and its skip footer for Markdown headings. A continued live read also uses revision. Versions uses projectId and fileId, then after and stamp. Version uses projectId and versionId, with optional offset and limit.";

const WRITE_DESCRIPTION = `${READ_DESCRIPTION} Create uses projectId, name and text. Edit changes part of a file with projectId, fileId, revision and 1 to ${MAX_EDITS} old/new pairs; every old must match exactly once, and all pairs apply or none. Replace sends the whole text only when the current file fits one read page; use edit for a larger file. Rename uses projectId, fileId, revision and name. Delete uses projectId, fileId and revision. Every change to an existing file names the revision read.`;

function principalOf(authInfo: unknown): KeyPrincipal {
  const principal = (authInfo as { extra?: { principal?: Principal } })?.extra
    ?.principal;
  if (principal?.via.kind !== "key") throw new Error("missing key principal");
  return principal as KeyPrincipal;
}

const forgedWrite = (principal: KeyPrincipal, input: unknown): boolean =>
  principal.via.scope === "read" &&
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  WRITE_ACTIONS.includes(String((input as { action?: unknown }).action));

async function call(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  tool: "projects" | "knowledge" | "sessions",
  input: unknown,
): Promise<McpResult> {
  const started = performance.now();
  let action = "invalid";
  try {
    let result: McpResult;
    if (tool === "projects") {
      const parsed = parseProjects(input);
      action = parsed.action;
      result = projectsTool(deps, principal, parsed);
    } else if (tool === "knowledge") {
      if (forgedWrite(principal, input)) {
        throw new HttpError(403, "this access key is read-only");
      }
      const parsed = parseKnowledge(input);
      action = parsed.action;
      result = knowledgeTool(deps, principal, parsed);
    } else {
      const parsed = parseSessions(input);
      action = parsed.action;
      result = sessionsTool(deps, principal, parsed);
    }
    deps.log.info("mcp call", {
      user: principal.username,
      key: principal.via.id,
      tool,
      action,
      status: 200,
      duration: performance.now() - started,
    });
    return result;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const fields = {
      user: principal.username,
      key: principal.via.id,
      tool,
      action,
      status,
      duration: performance.now() - started,
    };
    if (error instanceof HttpError) {
      deps.log.info("mcp call", fields);
      return errorResult(error.message);
    }
    deps.log.error("mcp call", { ...fields, ...errorFields(error) });
    return errorResult("internal error");
  }
}

function server(deps: McpServerDeps, principal: KeyPrincipal): McpServer {
  const instance = new McpServer(
    { name: "1ctx", version: deps.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  instance.registerTool(
    "projects",
    {
      description:
        "List reachable projects. Use after from the continuation to page.",
      inputSchema: schema(["list"], {
        action: { type: "string" },
        after: { type: ["string", "null"] },
      }),
    },
    (input) => call(deps, principal, "projects", input),
  );
  const canWrite = principal.via.scope === "write";
  instance.registerTool(
    "knowledge",
    {
      description: canWrite ? WRITE_DESCRIPTION : READ_DESCRIPTION,
      inputSchema: schema(
        canWrite ? [...READ_ACTIONS, ...WRITE_ACTIONS] : READ_ACTIONS,
        canWrite ? { ...readProperties, ...changeProperties } : readProperties,
      ),
    },
    (input) => call(deps, principal, "knowledge", input),
  );
  instance.registerTool(
    "sessions",
    {
      description:
        "Search finds chats and runs with projectId, q and after; a match needs every word, and double quotes make a phrase. List is newest first with projectId, optional ISO 8601 since, then after and readAt. Children carry parentSessionId. Take sessionId from a row to read its Markdown transcript, then use the footer's messageId and position to continue.",
      inputSchema: schema(["search", "list", "read"], {
        action: { type: "string" },
        projectId: { type: "string" },
        q: { type: "string" },
        since: { type: ["string", "null"], format: "date-time" },
        readAt: { type: ["string", "null"], format: "date-time" },
        after: { type: ["string", "null"] },
        sessionId: { type: "string" },
        messageId: { type: ["string", "null"] },
        position: { type: "integer", minimum: 0 },
      }),
    },
    (input) => call(deps, principal, "sessions", input),
  );
  return instance;
}

function sdkErrorFields(error: unknown): LogFields {
  const fields: LogFields = {
    error: "mcp sdk error",
    error_type: "exception",
  };
  if (error instanceof Error) {
    const name = error.name === "Error" ? error.constructor.name : error.name;
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) {
      fields.error_type = name;
    }
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && Number.isSafeInteger(code)) {
      fields.error_code = code;
    } else if (typeof code === "string" && /^-?\d{1,6}$/.test(code)) {
      fields.error_code = code;
    }
  }
  return fields;
}

export function serve(deps: McpServerDeps): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => server(deps, principalOf(authInfo)),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => deps.log.error("mcp error", sdkErrorFields(error)),
    },
  );
}
