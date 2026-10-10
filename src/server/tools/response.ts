// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What GET /api/tools answers: the built-ins, the web's access and
// search, and the tools with a switch of their own, each schema from
// the factory a send uses.

import type { ToolsResponse } from "../../shared/api/tools.ts";
import type { WebAccess } from "../../shared/web.ts";
import { AUTOMATION_TOOL, EMAIL_TOOL } from "../../shared/words.ts";
import { wireTokens } from "../providers/index.ts";
import { makeAutomationTool } from "./builtin/automation.ts";
import { makeEmailTool } from "./builtin/email.ts";
import { makeVisualizeTool } from "./builtin/visualize.ts";
import { builtinCatalog, fillYear, parametersHtml } from "./catalog.ts";
import type { ToolStore } from "./store.ts";

export function toolsResponse(input: {
  store: ToolStore;
  access: WebAccess;
  render: (markdown: string) => string;
  secret: (name: string) => string | null;
  // email is set up
  emailOn: boolean;
  now: number;
}): ToolsResponse {
  const { store, render, now } = input;
  const visual = store.row("visualize");
  const tool = fillYear([makeVisualizeTool(visual.hosts)], now)[0]!;
  const emailRow = store.row(EMAIL_TOOL);
  const emailTool = makeEmailTool(null);
  const automationRow = store.row(AUTOMATION_TOOL);
  const automationTool = makeAutomationTool(null, true);
  return {
    builtin: builtinCatalog(now, render),
    access: input.access,
    visualize: {
      name: "visualize",
      description: tool.description,
      parameters: tool.parameters,
      parametersHtml: parametersHtml(tool, render),
      tokens: wireTokens([tool]),
      enabled: visual.enabled,
      hosts: visual.hosts,
      updatedAt: visual.updatedAt,
    },
    emailUser: {
      name: EMAIL_TOOL,
      description: emailTool.description,
      parameters: emailTool.parameters,
      parametersHtml: parametersHtml(emailTool, render),
      tokens: wireTokens([emailTool]),
      enabled: emailRow.enabled,
      emailOn: input.emailOn,
      updatedAt: emailRow.updatedAt,
    },
    automation: {
      name: AUTOMATION_TOOL,
      description: automationTool.description,
      parameters: automationTool.parameters,
      parametersHtml: parametersHtml(automationTool, render),
      tokens: wireTokens([automationTool]),
      enabled: automationRow.enabled,
      updatedAt: automationRow.updatedAt,
    },
    search: {
      provider: store.row("websearch").provider,
      keys: {
        exa: input.secret("search-exa") !== null,
        firecrawl: input.secret("search-firecrawl") !== null,
        tavily: input.secret("search-tavily") !== null,
      },
    },
  };
}
