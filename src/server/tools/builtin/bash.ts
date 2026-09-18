// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schema needs no project or session so the agent page can count it;
// execution takes its identity only from the runner's call context.

import type { KnowledgeCapability } from "../../knowledge/index.ts";
import type { Tool, ToolResult } from "../types.ts";

export function makeBashTool(
  knowledge?: Pick<KnowledgeCapability, "run">,
): Tool<ToolResult> {
  return {
    name: "bash",
    description:
      "Run a bash command. The project's knowledge base, which people may call the project docs, is mounted at /knowledge: UTF-8 text files shared with everyone who can see the project. Use ls, find, grep -n, sed -n and sed -i, awk, jq, yq, diff, and cat > file <<'EOF' to write. Put independent commands in one round because calls run in parallel, and one command may read several files. Files you change there are saved when the command ends, each as a new version. If another writer changed one during the command nothing is saved and the result says so, so read it again and retry. Edit in place with sed -i. Read a file again in the same command before replacing it whole. Keep many small focused files, Markdown for prose, the file's purpose in its first line. /tmp is this session's scratch: any bytes, no versions, kept between commands until the session is deleted or unused for days. Nothing else is kept. Each command starts a new shell in the directory the last one ended in. Variables and functions do not carry over. File names use letters, digits, dot, dash and underscore. No network. The result is the output and the exit status, cut when long. Never write secrets: anyone who can see this session or the project can read what you write.",
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
        {
          callTimeoutMs: ctx.caps.callTimeoutMs,
          resultCut: ctx.caps.resultCut,
        },
        ctx.signal,
      );
    },
  };
}
