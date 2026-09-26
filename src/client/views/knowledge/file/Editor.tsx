// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The editor's band and its text box. The band says the revision being
// edited, the change counted after a pause in typing, and the size
// against the file's limit. The box is as tall as its lines, so the page
// scrolls and the box never does on its own.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { diffLines } from "../../../lib/diff.ts";
import { sizeWords } from "../../../lib/format.ts";
import { DiffStat } from "../../../ui/Diff.tsx";
import { editorRows, utf8Bytes } from "./DocPage.model.ts";

const COUNT_PAUSE_MS = 400;

type Counts = { added: number; removed: number } | "same" | null;

// what the band says of an edit: nothing changed, the lines added and
// removed, or nothing at all past the diff's size
export function changeCounts(before: string, text: string): Counts {
  if (text === before) return "same";
  const diff = diffLines(before, text);
  return diff.tooLarge ? null : { added: diff.added, removed: diff.removed };
}

export function EditorBand({
  revision,
  before,
  text,
  cap,
}: {
  revision: number;
  before: string;
  text: string;
  cap: number | null;
}) {
  const [counts, setCounts] = useState<Counts>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setCounts(changeCounts(before, text)),
      COUNT_PAUSE_MS,
    );
    return () => clearTimeout(timer);
  }, [before, text]);
  return (
    <div class="docpage-band">
      <span class="docpage-band-words">
        Editing revision {revision}
        {counts === "same" ? (
          " · no changes"
        ) : counts !== null ? (
          <>
            {" · "}
            <DiffStat added={counts.added} removed={counts.removed} />
          </>
        ) : null}
      </span>
      <SizeFact text={text} cap={cap} />
    </div>
  );
}

// "1.28 KB of 256 KB"
export function SizeFact({ text, cap }: { text: string; cap: number | null }) {
  const bytes = utf8Bytes(text);
  const over = cap !== null && bytes > cap;
  return (
    <span class={`docpage-fact${over ? " docpage-fact-over" : ""}`}>
      {sizeWords(bytes)}
      {cap !== null && ` of ${sizeWords(cap)}`}
    </span>
  );
}

export function EditorBox({
  name,
  text,
  placeholder,
  label,
  onInput,
}: {
  name: string;
  text: string;
  placeholder?: string;
  label?: string;
  onInput: (value: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // the height follows the text; the rows are the first guess
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // a narrower window wraps more lines
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [text]);
  return (
    <textarea
      ref={box}
      class="docpage-editor"
      name="text"
      spellcheck={false}
      autocapitalize="off"
      rows={Math.max(18, editorRows(text))}
      placeholder={placeholder}
      aria-label={label ?? `The text of ${name}`}
      value={text}
      onInput={(ev) => onInput(ev.currentTarget.value)}
    />
  );
}
