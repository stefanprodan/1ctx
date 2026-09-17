// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { hasLineBreak, MAX_TITLE } from "../../../shared/words.ts";
import { fields } from "../../lib/body.ts";
import { bytesWords } from "../../lib/bytes.ts";
import type { Tool } from "../types.ts";

export function makeVisualizeTool(hosts: readonly string[]): Tool {
  const sources =
    hosts.length === 0
      ? "Scripts, styles and fonts must be inline only."
      : `Scripts, styles and fonts may load only from ${hosts.join(", ")} or be inline.`;
  return {
    name: "visualize",
    description:
      "Draw an HTML or SVG visual for the user inside the chat. " +
      "It sits on the chat page, so give it no outer box, border or background. " +
      "Give the title first, then the HTML fragment with a short style, the content and scripts last. " +
      "A preview appears while the fragment arrives and its scripts run once the call is accepted. " +
      `${sources} Do not call visualize again for the same visual and do not repeat its source.`,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short title on one line.",
          minLength: 1,
          maxLength: MAX_TITLE,
        },
        html: {
          type: "string",
          description: "The HTML or SVG fragment, with scripts last.",
          minLength: 1,
        },
      },
      required: ["title", "html"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      ctx.signal.throwIfAborted();
      const { title, html } = fields(args, ["title", "html"]);
      if (
        typeof title !== "string" ||
        title.trim() === "" ||
        title.length > MAX_TITLE ||
        hasLineBreak(title)
      ) {
        throw new Error(
          `title must be one line of 1 to ${MAX_TITLE} characters`,
        );
      }
      if (typeof html !== "string" || html.trim() === "") {
        throw new Error("html must be a non-empty fragment");
      }
      if (ctx.budget.visuals >= ctx.caps.maxVisuals) {
        throw new Error(
          `visual limit reached: a send may draw ${ctx.caps.maxVisuals} visuals. Answer in text instead`,
        );
      }
      const size = Buffer.byteLength(html, "utf8");
      if (size > ctx.caps.visualBytes) {
        throw new Error(`visual exceeds ${bytesWords(ctx.caps.visualBytes)}`);
      }
      if (ctx.budget.visualBytes + size > ctx.caps.visualSendBytes) {
        throw new Error(
          `visuals exceed the send budget of ${bytesWords(ctx.caps.visualSendBytes)}`,
        );
      }
      ctx.budget.visualBytes += size;
      ctx.budget.visuals++;
      return `The visual "${title.trim()}" was accepted and is shown to the user. Do not call visualize again for it and do not repeat its source.`;
    },
  };
}
