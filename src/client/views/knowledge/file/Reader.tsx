// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file as it is read: the band (the revision, a link to History, who
// and when, and at its right the Outline and Preview or Source) over the whole
// text, Markdown rendered, an HTML file drawn as a visual, anything
// else by its numbered lines. And the aside's facts.

import { useSignal } from "@preact/signals";
import type { Ref } from "preact";
import { useRef } from "preact/hooks";
import type { KnowledgeFileView } from "../../../../shared/contracts/knowledge.ts";
import { VISUAL_FRAME_BYTES } from "../../../../shared/words.ts";
import { navigate } from "../../../app/router.ts";
import { switchable } from "../../../data/capabilities.ts";
import {
  ago,
  count,
  longDate,
  plural,
  sizeWords,
} from "../../../lib/format.ts";
import { Seg } from "../../../ui/Seg.tsx";
import { Source } from "../../../ui/Source.tsx";
import { AsideLine, AsideSection } from "../../../ui/Split.tsx";
import { Author } from "../Author.tsx";
import { authorOf, historyHref } from "../Knowledge.model.ts";
import { OutlineMenu } from "./DocMenus.tsx";
import { OUTLINE_FROM, outlineOf, utf8Bytes } from "./DocPage.model.ts";
import { DocVisual } from "./DocVisual.tsx";

// the facts the aside holds; the foot says them where the aside is
// hidden
export function Facts({ file }: { file: KnowledgeFileView }) {
  return (
    <AsideSection label="File">
      <AsideLine label="Size">
        {sizeWords(file.bytes)} · {plural(file.lines, "line")}
      </AsideLine>
      <AsideLine label="Tokens">{count(file.tokens)}</AsideLine>
      <AsideLine label="Revisions">{file.revision}</AsideLine>
      <AsideLine label="Created">{longDate(file.createdAt)}</AsideLine>
    </AsideSection>
  );
}

export function MarkdownBody({
  html,
  body,
}: {
  html: string;
  body?: Ref<HTMLDivElement>;
}) {
  return (
    // the server renders the Markdown with raw HTML off: render/ is the
    // safety boundary
    <div
      class="docpage-md md-wide"
      ref={body}
      dangerouslySetInnerHTML={{ __html: html }}
    />
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
        <span class="docpage-band-words docpage-band-line cut">
          <a class="docpage-link" href={historyHref(file.projectId, file.id)}>
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
          <Seg
            label="Show"
            small
            options={[
              { value: "preview", label: "Preview" },
              { value: "source", label: "Source" },
            ]}
            value={view}
            onPick={(value) => {
              shown.value = value;
              if (line !== null) navigate(href, true);
            }}
          />
        )}
      </div>
      {view === "preview" && markdown ? (
        <MarkdownBody html={file.html ?? ""} body={mdBody} />
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
