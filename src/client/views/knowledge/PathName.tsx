// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file's name as the lists draw it, and a search's marks on a text.

import { marked, pathParts } from "./Knowledge.model.ts";

export function Marks({ text, q }: { text: string; q: string }) {
  return (
    <>
      {marked(text, q).map((part, i) =>
        part.mark ? (
          <mark key={i} class="knowledge-mark">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

// a path with its folder faint, the name as it stands, both marked when
// a search asks; a long path cuts its folder, never the name, until the
// name alone is too long
export function PathName({ name, q = "" }: { name: string; q?: string }) {
  const { dir, base } = pathParts(name);
  return (
    <span class="knowledge-path">
      {dir !== "" && (
        <span class="knowledge-dir cut">
          <Marks text={dir} q={q} />
        </span>
      )}
      <span class="cut">
        <Marks text={base} q={q} />
      </span>
    </span>
  );
}
