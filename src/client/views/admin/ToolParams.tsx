// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { showAll } from "../../lib/format.ts";
import { useCut } from "../../lib/resize.ts";
import { copyCode } from "../../transcript/copy.ts";
import { Fold } from "../../ui/Fold.tsx";
import { jsonLines } from "./Tools.model.ts";
import "../../transcript/hljs.css";
import "../../transcript/md.css";
import "./tool-params.css";

// a tool's parameters as its open row shows them
export function ToolParams({
  tool,
}: {
  tool: { parameters: object; parametersHtml: string };
}) {
  // cut to a height, not scrolled: a box that scrolls inside the page's
  // scroll leaves the page's sticky head behind
  const { el, open, long } = useCut<HTMLDivElement>([tool.parametersHtml]);
  // Copy is a button inside rendered HTML, so the click is delegated
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const on = (ev: MouseEvent) => void copyCode(ev);
    node.addEventListener("click", on);
    return () => node.removeEventListener("click", on);
  }, []);
  return (
    <Fold
      cut={long.value && !open.value}
      onOpen={() => {
        open.value = true;
      }}
      label={showAll(jsonLines(tool.parameters))}
      framed
    >
      <div
        class={open.value ? undefined : "tool-params-cut"}
        ref={el}
        // rendered on the server, so the Markdown parser stays out of
        // the browser
        dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
      />
    </Fold>
  );
}
