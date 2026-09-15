// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type McpContent = {
  type: string;
  [key: string]: unknown;
};

export type McpResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

function contentLine(part: McpContent): string | null {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "image") return "[image omitted]";
  if (part.type === "audio") return "[audio omitted]";
  if (
    part.type === "resource" &&
    typeof part.resource === "object" &&
    part.resource !== null
  ) {
    const resource = part.resource as Record<string, unknown>;
    return typeof resource.text === "string"
      ? resource.text
      : "[resource omitted]";
  }
  if (part.type === "resource_link" && typeof part.uri === "string") {
    return part.uri;
  }
  return null;
}

export function resultText(result: McpResult): {
  text: string;
  isError: boolean;
} {
  const content = Array.isArray(result.content) ? result.content : [];
  const hasText = content.some((part) => part.type === "text");
  let text: string;
  if (!hasText && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
  } else {
    text = content
      .map(contentLine)
      .filter((line): line is string => line !== null)
      .join("\n");
  }
  return {
    text: result.isError && text === "" ? "the server returned an error" : text,
    isError: result.isError === true,
  };
}
