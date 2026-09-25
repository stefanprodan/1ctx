// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A text by its numbered lines: the server's highlighted HTML cut at
// each newline, or the plain text when there is none. A number links to
// its line when the view gives the address; the lit line is marked and
// scrolled into view once, on arrival and when it moves. Long lines
// wrap, so the block never scrolls on its own.

import { useEffect, useMemo, useRef } from "preact/hooks";
import { splitLines, textLines } from "../lib/lines.ts";
// the page may draw no transcript, whose sheet colours the tokens
import "../transcript/hljs.css";
import "./source.css";

export function Source({
  text,
  html = null,
  lit = null,
  lineHref,
}: {
  // the text as stored: it sets the count of lines
  text: string;
  // the server's highlighted text as one string, null to draw the text
  html?: string | null;
  // the line to mark, from 1
  lit?: number | null;
  // a number's address, "?line=12" or the like; without it a number is
  // no link
  lineHref?: (line: number) => string;
}) {
  const lines = useMemo(() => textLines(text), [text]);
  // the server's HTML is trusted markup from render/: each line is
  // balanced by the splitter, so one line never closes another's span
  const marked = useMemo(
    () => (html === null ? null : splitLines(html)),
    [html],
  );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lit === null) return;
    box.current
      ?.querySelector(".source-num.source-lit")
      ?.scrollIntoView({ block: "center" });
  }, [lit]);
  return (
    <div class="source" ref={box}>
      {lines.map((line, i) => {
        const n = i + 1;
        const on = n === lit ? " source-lit" : "";
        return [
          lineHref ? (
            <a
              key={`n${n}`}
              class={`source-num${on}`}
              href={lineHref(n)}
              aria-current={on ? "location" : undefined}
            >
              {n}
            </a>
          ) : (
            <span key={`n${n}`} class={`source-num${on}`} aria-hidden="true">
              {n}
            </span>
          ),
          marked === null ? (
            <span key={`t${n}`} class={`source-text${on}`}>
              {line}
            </span>
          ) : (
            <span
              key={`t${n}`}
              class={`source-text${on}`}
              dangerouslySetInnerHTML={{ __html: marked[i] ?? "" }}
            />
          ),
        ];
      })}
    </div>
  );
}
