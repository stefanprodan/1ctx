// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schema needs no project or session so the agent page can count it;
// execution takes its identity only from the runner's call context.

import type { WebSnapshot } from "../../../shared/web.ts";
import type { KnowledgeCapability } from "../../knowledge/index.ts";
import type { Tool, ToolResult } from "../types.ts";
import { domainWords } from "../web.ts";

// the description is about the docs, the tool's main job, so the
// network gets one sentence: what curl is good for and where it reaches
function networkWords(web: WebSnapshot | null): string {
  if (web === null) return "No network.";
  const where =
    web.mode === "all" ? "any host" : `these hosts only: ${domainWords(web)}`;
  return `curl calls HTTP APIs on ${where}, JSON in and out with -X, -H, -d and jq. Save downloads in /tmp.`;
}

export function makeBashTool(
  knowledge?: Pick<KnowledgeCapability, "run">,
  web: WebSnapshot | null = null,
  visuals = true,
): Tool<ToolResult> {
  return {
    name: "bash",
    description:
      "Run a bash command in a sandbox over the project's files. /knowledge holds the project docs: UTF-8 text shared with everyone in the project, often many large files. /tmp is this chat's scratch for any bytes, kept between commands. /uploads holds the files the user attached, read-only. Navigate, never dump, since a long result is cut. Find the file first: ls and find for names, rg -il 'word' /knowledge for the files that mention a word. Then grep -n in that file for the line, grep -n '^#' for its outline, and read around a line with sed -n '40,120p'. Check wc -l before reading. Never cat a big file or print matching lines from the whole tree. Edit in place with sed -i, create a file with cat > file <<'EOF', read a file before replacing it whole, and print the changed lines after. Changes are saved as a new version when the command ends. If someone else changed the file meanwhile nothing is saved and the result says so: read again and retry. Prefer small Markdown files whose first line says their purpose, named with letters, digits, dot, dash and underscore. Each command is a new shell that starts in the last directory, so variables do not carry over. Put the steps of one task in one command, and independent commands in one round, where they run in parallel. jq, yq, awk and diff are there, git, python and node are not. Never write secrets, since others can read this chat and the project. open <file> shows a file to the user as it is: HTML and SVG as a visual, Markdown rendered, other text as code. To show a file, open it rather than reading it out. " +
      networkWords(web),
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
      return knowledge.run(
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
            },
        ctx.signal,
      );
    },
  };
}
