// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who wrote a file and from where, as a row or a band says it, a user
// and an agent alike as a handle: linked
// where the line is not itself a link, as words where it is. A write
// over an access key adds "via" and the key's name.

import { RowsHandle } from "../../ui/Rows.tsx";
import type { AuthorWords } from "./Knowledge.model.ts";
import "./knowledge.css";

// their page, and the chat or the run the write came from
export function Author({ words }: { words: AuthorWords }) {
  return (
    <>
      <a class="knowledge-link" href={words.href}>
        <RowsHandle name={words.name} />
      </a>
      {words.via !== null && ` via ${words.via}`}
      {words.where !== null && words.whereHref !== null && (
        <>
          {" "}
          <a class="knowledge-where" href={words.whereHref}>
            {words.where}
          </a>
        </>
      )}
    </>
  );
}

// inside a link, where nothing else may be one
export function AuthorText({ words }: { words: AuthorWords }) {
  return (
    <>
      <RowsHandle name={words.name} />
      {words.via !== null && ` via ${words.via}`}
      {words.where !== null && ` ${words.where}`}
    </>
  );
}
