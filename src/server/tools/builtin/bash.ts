// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schema needs no project or session so the agent page can count it;
// execution takes its identity only from the runner's call context.

import type { WebSnapshot } from "../../../shared/web.ts";
import { headerValue, type KeyRead } from "../../credentials/index.ts";
import {
  type CommandCredential,
  type KnowledgeCapability,
  type Refusal,
  scrubKeys,
} from "../../knowledge/index.ts";
import type { OfferedCredential, Tool, ToolResult } from "../types.ts";
import { domainWords } from "../web.ts";

// what a command asks of the credentials area: the row as it is now and
// the key its file holds now
export type CredentialKeysPort = {
  byId(
    id: string,
  ):
    | (Pick<
        OfferedCredential,
        "keyName" | "prefix" | "header" | "template" | "methods"
      > & { projectIds: string[] })
    | null;
  readKey(keyName: string): KeyRead;
};

export type BashCredentials = {
  offered: readonly OfferedCredential[];
  off: readonly { name: string; prefix: string }[];
};

const NONE: BashCredentials = { offered: [], off: [] };
const MAX_PREFIX_WORDS = 80;

const prefixWords = (prefix: string) =>
  prefix.length > MAX_PREFIX_WORDS
    ? `${prefix.slice(0, MAX_PREFIX_WORDS - 3)}...`
    : prefix;

// the description is about the docs, the tool's main job, so the
// network gets one sentence: what curl is good for and where it reaches,
// then one clause per credential the send signs with
function networkWords(
  web: WebSnapshot | null,
  credentials: readonly OfferedCredential[],
): string {
  if (web === null) return "No network.";
  const where =
    web.mode === "all" ? "any host" : `these hosts only: ${domainWords(web)}`;
  return [
    `curl calls HTTP APIs on ${where}, JSON in and out with -X, -H, -d and jq. Save downloads in /tmp.`,
    ...credentials.map(
      (credential) =>
        `curl to ${prefixWords(credential.prefix)} (${credential.name}) is signed in; send no key.`,
    ),
  ].join(" ");
}

// a send signs only as its snapshot says, so a row moved under it, the
// key file it names included, refuses until the next send
const changed = (
  snapshot: OfferedCredential,
  row: NonNullable<ReturnType<CredentialKeysPort["byId"]>>,
) =>
  row.keyName !== snapshot.keyName ||
  row.prefix !== snapshot.prefix ||
  row.header !== snapshot.header ||
  row.template !== snapshot.template ||
  row.methods.join() !== snapshot.methods.join();

// each credential as this command sees it: the row checked by id and the
// key read now, so a replaced file applies to the next command and a
// removed or changed row refuses it
export function commandCredentials(
  credentials: BashCredentials,
  port: CredentialKeysPort | undefined,
  projectId: string,
): CommandCredential[] {
  const refused = (
    credential: { name: string; prefix: string },
    why: Refusal,
  ): CommandCredential => ({
    name: credential.name,
    prefix: credential.prefix,
    refused: why,
  });
  return [
    ...credentials.offered.map((credential) => {
      const row = port?.byId(credential.id) ?? null;
      if (row === null || !row.projectIds.includes(projectId)) {
        return refused(credential, "deleted");
      }
      if (changed(credential, row)) return refused(credential, "changed");
      const read = port!.readKey(row.keyName);
      if (!read.ok) return refused(credential, read.reason);
      return {
        name: credential.name,
        prefix: credential.prefix,
        key: read.key,
        header: credential.header,
        value: headerValue(credential.template, read.key),
        methods: [...credential.methods],
      };
    }),
    ...credentials.off.map((credential) => refused(credential, "off")),
  ];
}

// the tail keeps its length, the receipts the registry keeps apart
function scrubbed(
  result: ToolResult,
  credentials: readonly CommandCredential[],
): ToolResult {
  if (!credentials.some((credential) => "key" in credential)) return result;
  const tail = result.tail ?? 0;
  const head = scrubKeys(
    result.content.slice(0, result.content.length - tail),
    credentials,
  );
  const end = scrubKeys(
    result.content.slice(result.content.length - tail),
    credentials,
  );
  return {
    ...result,
    content: head + end,
    ...(result.tail === undefined ? {} : { tail: end.length }),
  };
}

export function makeBashTool(
  knowledge?: Pick<KnowledgeCapability, "run">,
  web: WebSnapshot | null = null,
  visuals = true,
  credentials: BashCredentials = NONE,
  keys?: CredentialKeysPort,
): Tool<ToolResult> {
  return {
    name: "bash",
    description:
      "Run a bash command in a sandbox over the project's files. /knowledge holds the project docs: UTF-8 text shared with everyone in the project, often many large files. /tmp is this chat's scratch for any bytes, kept between commands. /uploads holds the files the user attached, read-only. Navigate, never dump, since a long result is cut. Find the file first: ls and find for names, rg -il 'word' /knowledge for the files that mention a word. Then grep -n in that file for the line, grep -n '^#' for its outline, and read around a line with sed -n '40,120p'. Check wc -l before reading. Never cat a big file or print matching lines from the whole tree. Edit in place with sed -i, create a file with cat > file <<'EOF', read a file before replacing it whole, and print the changed lines after. Changes are saved as a new version when the command ends. If someone else changed the file meanwhile nothing is saved and the result says so: read again and retry. Prefer small Markdown files whose first line says their purpose, named with letters, digits, dot, dash and underscore. Each command is a new shell that starts in the last directory, so variables do not carry over. Put the steps of one task in one command, and independent commands in one round, where they run in parallel. jq, yq, awk and diff are there, git, python and node are not. Never write secrets, since others can read this chat and the project. open <file> shows a file to the user as it is: HTML and SVG as a visual, Markdown rendered, other text as code. To show a file, open it rather than reading it out. " +
      networkWords(web, credentials.offered),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line, as for bash -c.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const actor = ctx.actor;
      if (actor === null) return { content: "no project", error: true };
      if (Object.keys(args).some((name) => name !== "command")) {
        throw new Error("bash accepts only command");
      }
      if (typeof args.command !== "string") {
        throw new Error("command must be a string");
      }
      if (knowledge === undefined) {
        throw new Error("knowledge is not configured");
      }
      if (ctx.budget.bashCalls >= ctx.caps.maxBashCalls) {
        return {
          content: "the bash budget for this reply is spent",
          error: true,
        };
      }
      ctx.budget.bashCalls++;
      const caps = {
        callTimeoutMs: ctx.caps.callTimeoutMs,
        resultCut: ctx.caps.resultCut,
        visuals,
      };
      const signing =
        ctx.web === null
          ? []
          : commandCredentials(credentials, keys, actor.projectId);
      const result = await knowledge.run(
        actor.projectId,
        actor.sessionId,
        {
          kind: "agent",
          id: actor.agentId,
          name: actor.agentName,
          sessionId: actor.sessionId,
          origin: actor.origin,
        },
        args.command,
        ctx.web === null
          ? caps
          : {
              ...caps,
              web: ctx.web,
              fetchDeadlineMs: ctx.caps.fetchDeadlineMs,
              fetchBodyBytes: ctx.caps.fetchBodyBytes,
              ...(signing.length === 0 ? {} : { credentials: signing }),
            },
        ctx.signal,
      );
      return scrubbed(result, signing);
    },
  };
}
