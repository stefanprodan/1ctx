// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file as it is read: the band (the revision, a link to History, who
// and when, and at its right the Outline and Preview or Source) over the whole
// text, Markdown rendered, an HTML file drawn as a visual, anything
// else by its numbered lines. And the aside's facts.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { KnowledgeFileView } from "../../../../shared/contracts/knowledge.ts";
import { VISUAL_FRAME_BYTES } from "../../../../shared/words.ts";
import { navigate } from "../../../app/router.ts";
import { switchable } from "../../../data/capabilities.ts";
import { ago, count, longDate } from "../../../lib/format.ts";
import { Source } from "../../../ui/Source.tsx";
import { AsideSection } from "../../../ui/Split.tsx";
import { Author } from "../Author.tsx";
import { authorOf, plural, sizeWords } from "../Knowledge.model.ts";
import { OutlineMenu } from "./DocMenus.tsx";
import { OUTLINE_FROM, outlineOf, utf8Bytes } from "./DocPage.model.ts";
import { DocVisual } from "./DocVisual.tsx";

// the facts the aside holds; the foot says them where the aside is
// hidden
export function Facts({ file }: { file: KnowledgeFileView }) {
  return (
    <AsideSection label="File">
      <div class="split-line">
        Size
        <span class="split-strong">
          {sizeWords(file.bytes)} · {plural(file.lines, "line")}
        </span>
      </div>
      <div class="split-line">
        Tokens<span class="split-strong">{count(file.tokens)}</span>
      </div>
      <div class="split-line">
        Revisions<span class="split-strong">{file.revision}</span>
      </div>
      <div class="split-line">
        Created<span class="split-strong">{longDate(file.createdAt)}</span>
      </div>
    </AsideSection>
  );
}

// an HTML file draws as a visual only while the admin's Visuals row is
// on, which the project's agents answer said, and within the frame's size
function drawsVisual(file: KnowledgeFileView): boolean {
  return (
    (file.kind === "html" || file.kind === "htm") &&
    (switchable.value?.includes("visualize") ?? false) &&
    utf8Bytes(file.text) <= VISUAL_FRAME_BYTES
  );
}

export function Reader({
  file,
  href,
  line,
  now,
}: {
  file: KnowledgeFileView;
  // the file page's address
  href: string;
  // ?line=, which shows the source with the line lit
  line: number | null;
  now: number;
}) {
  const shown = useSignal<"preview" | "source">("preview");
  const mdBody = useRef<HTMLDivElement>(null);
  const markdown = file.html !== null;
  const visual = drawsVisual(file);
  const previewable = markdown || visual;
  const view = line !== null || !previewable ? "source" : shown.value;
  const outline = markdown && view === "preview" ? outlineOf(file.html) : [];
  return (
    <>
      <div class="docpage-band">
        {/* who and when leave a phone's band for the foot, where a long
            name may wrap; History is also the head's More */}
        <span class="docpage-band-words docpage-band-line">
          <a class="docpage-link" href={`${href}?history`}>
            Revision {file.revision}
          </a>
          <span class="docpage-wide">
            {" "}
            · <Author words={authorOf(file.author)} /> ·{" "}
            {ago(file.updatedAt, now)}
          </span>
        </span>
        {outline.length >= OUTLINE_FROM && (
          <OutlineMenu entries={outline} body={() => mdBody.current} />
        )}
        {previewable && (
          <fieldset class="seg seg-small" aria-label="Show">
            {(["preview", "source"] as const).map((value) => (
              <button
                key={value}
                type="button"
                class={`seg-option${view === value ? " seg-on" : ""}`}
                aria-pressed={view === value}
                onClick={() => {
                  shown.value = value;
                  if (line !== null) navigate(href, true);
                }}
              >
                {value === "preview" ? "Preview" : "Source"}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {view === "preview" && markdown ? (
        // the server renders the Markdown with raw HTML off: render/ is
        // the safety boundary
        <div
          class="docpage-md md-wide"
          ref={mdBody}
          dangerouslySetInnerHTML={{ __html: file.html ?? "" }}
        />
      ) : view === "preview" && visual ? (
        <DocVisual
          fileId={file.id}
          revision={file.revision}
          html={file.text}
          title={file.name}
        />
      ) : (
        <Source
          text={file.text}
          html={file.code}
          lit={line}
          lineHref={(n) => `${href}?line=${n}`}
        />
      )}
      {/* the aside's facts, where the aside is hidden */}
      <p class="docpage-foot">
        <span class="docpage-phone">
          Last changed by <Author words={authorOf(file.author)} />,{" "}
          {longDate(file.updatedAt)}
          <br />
        </span>
        {sizeWords(file.bytes)} · {plural(file.lines, "line")} ·{" "}
        {plural(file.tokens, "token")} · created {longDate(file.createdAt)}
      </p>
    </>
  );
}
