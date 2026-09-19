// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The webfetch tool: a plain fetch that follows redirects, cuts the body
// at the cap and reaches under the deadline. Listed access checks every
// origin before a request, including redirects. The fetch comes from the dependency, so the
// suite passes a fake and never leaves the process. The body cap, the
// deadline and the result cut come from the tool caps on the context.

import { originAllowed, type WebSnapshot } from "../../../shared/web.ts";
import { bytesWords } from "../../lib/bytes.ts";
import type { Tool, ToolContext } from "../types.ts";

function cutNote(maxBytes: number): string {
  return `<error>Content truncated at ${bytesWords(maxBytes)}.</error>`;
}

// what reaches the network; a test passes a fake
export type FetchDependencies = {
  fetch: typeof fetch;
};

type MediaType = {
  type: string;
  charset: string;
};

class TextWriter {
  private value = "";
  private pendingSpace = false;

  text(text: string): void {
    for (const character of text) {
      if (/\s/u.test(character)) {
        this.pendingSpace = true;
      } else {
        if (
          this.pendingSpace &&
          this.value !== "" &&
          !this.value.endsWith("\n") &&
          !this.value.endsWith(" ")
        ) {
          this.value += " ";
        }
        this.pendingSpace = false;
        this.value += character;
      }
    }
  }

  raw(text: string): void {
    this.pendingSpace = false;
    this.value += text;
  }

  line(): void {
    this.pendingSpace = false;
    this.value = this.value.replace(/[ \t]+$/u, "");
    if (!this.value.endsWith("\n\n")) this.value += "\n";
  }

  singleLine(): void {
    this.pendingSpace = false;
    this.value = this.value.replace(/[ \t]+$/u, "");
    if (!this.value.endsWith("\n")) this.value += "\n";
  }

  result(): string {
    return this.value.trim();
  }
}

function normalizedHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

export function parseFetchUrl(
  input: string,
  web: WebSnapshot | null = null,
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid URL "${input}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`scheme "${url.protocol}" is not allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("credentials in URLs are not allowed");
  }
  if (web?.mode === "listed" && !originAllowed(url, web.domains)) {
    throw new Error(`not an allowed domain: ${url.host}`);
  }
  const host = normalizedHost(url.hostname);
  if (host === "") throw new Error("URL has no host");
  url.hostname = host.includes(":") ? `[${host}]` : host;
  return url;
}

function mediaType(header: string | null): MediaType {
  if (header === null || header.trim() === "") {
    throw new Error("media type is missing");
  }
  const type = header.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(type)) {
    throw new Error(`media type "${type}" is not allowed`);
  }
  const allowed =
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml");
  if (!allowed) throw new Error(`media type "${type}" is not allowed`);
  const match = header.match(
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu,
  );
  return {
    type,
    charset: match?.[1] || match?.[2] || match?.[3] || "utf-8",
  };
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    if (size === maxBytes) {
      cut = true;
      await reader.cancel();
      break;
    }
    const remaining = maxBytes - size;
    const chunk =
      value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (value.byteLength > remaining) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, cut };
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function extractHtml(html: string, baseUrl: URL): Promise<string> {
  const body = new TextWriter();
  const title = new TextWriter();
  let skipDepth = 0;
  let preDepth = 0;
  let titleDepth = 0;
  const rewriter = new HTMLRewriter();

  rewriter.on(
    "script, style, noscript, iframe, svg, template, nav, footer, header",
    {
      element(element) {
        skipDepth++;
        element.onEndTag(() => {
          skipDepth--;
        });
        element.remove();
      },
    },
  );
  rewriter.on("title", {
    element(element) {
      titleDepth++;
      element.onEndTag(() => {
        titleDepth--;
      });
    },
  });
  rewriter.on(
    "p, div, section, article, main, tr, blockquote, table, ul, ol, dl, dt, dd",
    {
      element(element) {
        if (skipDepth > 0) return;
        body.line();
        element.onEndTag(() => body.line());
      },
    },
  );
  rewriter.on("br, hr", {
    element() {
      if (skipDepth === 0) body.line();
    },
  });
  for (let level = 1; level <= 6; level++) {
    rewriter.on(`h${level}`, {
      element(element) {
        if (skipDepth > 0) return;
        body.line();
        body.text(`${"#".repeat(level)} `);
        element.onEndTag(() => body.line());
      },
    });
  }
  rewriter.on("li", {
    element(element) {
      if (skipDepth > 0) return;
      body.singleLine();
      body.text("- ");
      element.onEndTag(() => body.singleLine());
    },
  });
  rewriter.on("pre", {
    element(element) {
      if (skipDepth > 0) return;
      body.line();
      preDepth++;
      element.onEndTag(() => {
        preDepth--;
        body.line();
      });
    },
  });
  rewriter.on("a", {
    element(element) {
      if (skipDepth > 0) return;
      const href = element.getAttribute("href");
      if (!href) return;
      let absolute: URL;
      try {
        absolute = new URL(href, baseUrl);
      } catch {
        return;
      }
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
        return;
      }
      element.onEndTag(() => body.text(` (${absolute.href})`));
    },
  });
  rewriter.on("*", {
    text(text) {
      if (skipDepth > 0) return;
      if (titleDepth > 0) {
        title.text(text.text);
      } else if (preDepth > 0) {
        body.raw(text.text);
      } else {
        body.text(text.text);
      }
    },
  });

  await rewriter.transform(new Response(html)).text();
  const pageTitle = title.result();
  const pageBody = body.result();
  if (pageTitle && pageBody) return `${pageTitle}\n\n${pageBody}`;
  return pageTitle || pageBody;
}

export function sliceContent(
  text: string,
  startIndex: number,
  maxLength: number,
): string {
  if (startIndex >= text.length) {
    return "<error>No more content available.</error>";
  }
  const end = startIndex + maxLength;
  const result = text.slice(startIndex, end);
  if (end < text.length) {
    return `${result}\n\n<error>Content truncated. Call the webfetch tool with a start_index of ${end} to get more content.</error>`;
  }
  return result;
}

function integerArgument(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < minimum ||
    (maximum !== undefined && result > maximum)
  ) {
    const range =
      maximum === undefined ? `at least ${minimum}` : `${minimum}..${maximum}`;
    throw new Error(`${name} must be an integer in ${range}`);
  }
  return result;
}

export async function fetchText(
  args: Record<string, unknown>,
  ctx: ToolContext,
  version: string,
  dependencies: FetchDependencies = { fetch },
): Promise<string> {
  if (typeof args.url !== "string" || args.url === "") {
    throw new Error("url must be a non-empty string");
  }
  const maxLength = integerArgument(
    args.max_length,
    "max_length",
    5000,
    1,
    50_000,
  );
  const startIndex = integerArgument(args.start_index, "start_index", 0, 0);
  if (ctx.budget.fetches >= ctx.caps.maxFetches) {
    throw new Error("fetch limit reached");
  }
  ctx.budget.fetches++;

  const deadline = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(ctx.caps.fetchDeadlineMs),
  ]);
  try {
    let url = parseFetchUrl(args.url, ctx.web);
    let redirects = 0;

    while (true) {
      deadline.throwIfAborted();
      const response = await dependencies.fetch(url.href, {
        method: "GET",
        headers: {
          "User-Agent": `1ctx/${version}`,
          Accept:
            "text/html, text/plain, application/json, application/xml, text/*;q=0.9",
        },
        redirect: "manual",
        signal: deadline,
      });
      const location = response.headers.get("location");
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        location !== null
      ) {
        await response.body?.cancel();
        if (redirects >= 3) {
          throw new Error("redirect limit exceeded after 3 hops");
        }
        try {
          url = parseFetchUrl(new URL(location, url).href, ctx.web);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`redirect refused: ${reason}`);
        }
        redirects++;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new Error(`HTTP status ${response.status}`);
      }

      const type = mediaType(response.headers.get("content-type"));
      const body = await readBody(response, deadline, ctx.caps.fetchBodyBytes);
      let text = decode(body.bytes, type.charset);
      if (type.type === "text/html" || type.type === "application/xhtml+xml") {
        text = await extractHtml(text, url);
      }
      if (body.cut) text = `${text}\n\n${cutNote(ctx.caps.fetchBodyBytes)}`;
      return sliceContent(text, startIndex, maxLength);
    }
  } catch (error) {
    if (
      deadline.aborted &&
      deadline.reason instanceof DOMException &&
      deadline.reason.name === "TimeoutError"
    ) {
      throw new Error(
        `fetch timed out after ${ctx.caps.fetchDeadlineMs / 1000} seconds`,
      );
    }
    throw error;
  }
}

// the tool the area builds per send, with the version bound
export function makeWebfetchTool(
  version: string,
  dependencies: FetchDependencies = { fetch },
  web: WebSnapshot | null = null,
): Tool {
  return {
    name: "webfetch",
    description:
      "Fetch a URL and return its text. Long pages are returned in slices; call webfetch again with start_index set to the next index named in the truncation message." +
      (web?.mode === "listed"
        ? ` Only these hosts are allowed: ${web.domains.join(", ")}.`
        : ""),
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch.",
        },
        max_length: {
          type: "integer",
          minimum: 1,
          maximum: 50_000,
          default: 5000,
          description: "Maximum number of characters to return.",
        },
        start_index: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Character index at which to start the returned slice.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    run: (args, ctx) => fetchText(args, ctx, version, dependencies),
  };
}
