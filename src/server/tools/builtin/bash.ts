// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell over project text, never the host. The schema needs no
// project so the agent page can count it; execution takes its project
// and author only from the runner's call context.

import type { KnowledgeCapability } from "../../knowledge/index.ts";
import type { Tool, ToolResult } from "../types.ts";

export function makeBashTool(
  knowledge?: Pick<KnowledgeCapability, "run">,
): Tool<ToolResult> {
  return {
    name: "bash",
    description:
      "Run a bash command in the project's knowledge base, mounted at /knowledge, the working directory. Every file is UTF-8 text; use ls, find, grep -n, sed -n and sed -i, awk, jq, yq, diff, and cat > file <<'EOF' to write. No network and nothing outside /knowledge is kept. The result is the output and the exit status, cut when long. Files you changed are saved when the command ends, each as a new version; if another agent changed one of them during the command nothing is saved and the result says so, so read it again and retry. Edit in place with sed -i; read a file again in the same command before replacing it whole. Keep many small focused files rather than one large one, Markdown for prose, the file's purpose in its first line. Never write secrets: the base is shared with every member of the project.",
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
      return knowledge.run(
        actor.projectId,
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
