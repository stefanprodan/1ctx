// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fetched page's HTML as text, for webfetch.

const isBlank = (code: number) => code === 0x20 || code === 0x09;

// The text is kept in pieces with its last two characters and the
// count of blanks that end it: a page's every block rule asks about the
// end, and reading the end of one joined string copies all of it, or
// rescans a long <pre> run of blanks, each time.
class TextWriter {
  private parts: string[] = [];
  private tail = "";
  private blanks = 0;
  private pendingSpace = false;

  private append(text: string): void {
    if (text === "") return;
    this.parts.push(text);
    this.tail = (this.tail + text.slice(-2)).slice(-2);
    let end = text.length;
    while (end > 0 && isBlank(text.charCodeAt(end - 1))) end--;
    this.blanks = end === 0 ? this.blanks + text.length : text.length - end;
  }

  private trimBlanks(): void {
    if (this.blanks === 0) return;
    let drop = this.blanks;
    this.blanks = 0;
    while (drop > 0) {
      const last = this.parts.pop()!;
      if (last.length > drop) {
        this.parts.push(last.slice(0, last.length - drop));
        break;
      }
      drop -= last.length;
    }
    this.tail = "";
    for (let i = this.parts.length - 1; i >= 0 && this.tail.length < 2; i--) {
      this.tail = this.parts[i]!.slice(this.tail.length - 2) + this.tail;
    }
  }

  text(text: string): void {
    let run = "";
    let last = this.tail.slice(-1);
    for (const character of text) {
      if (/\s/u.test(character)) {
        this.pendingSpace = true;
      } else {
        if (this.pendingSpace && last !== "" && last !== "\n" && last !== " ") {
          run += " ";
        }
        this.pendingSpace = false;
        run += character;
        last = character;
      }
    }
    this.append(run);
  }

  raw(text: string): void {
    this.pendingSpace = false;
    this.append(text);
  }

  line(): void {
    this.pendingSpace = false;
    this.trimBlanks();
    if (this.tail !== "\n\n") this.append("\n");
  }

  singleLine(): void {
    this.pendingSpace = false;
    this.trimBlanks();
    if (!this.tail.endsWith("\n")) this.append("\n");
  }

  result(): string {
    return this.parts.join("").trim();
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
