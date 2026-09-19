// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message: who wrote it and when, then the text in a card, and
// inside the card the files it carried, as they were at the send. The
// name leads to the author's page when the author is known.

import type { Message } from "../../shared/contracts/session.ts";
import { clock, initials } from "../lib/format.ts";
import { userHref } from "../lib/hrefs.ts";
import { FileChip } from "../ui/FileChip.tsx";
import { plural, sizeWords } from "../views/knowledge/Knowledge.model.ts";

export function UserRow({
  message: m,
  author,
}: {
  message: Message;
  author: { name: string; username: string | null };
}) {
  return (
    <div class="transcript-user">
      <div class="transcript-author">
        <span class="avatar avatar-24">{initials(author.name)}</span>
        {author.username === null ? (
          <span class="transcript-name">{author.name}</span>
        ) : (
          <a
            class="transcript-name transcript-name-link"
            href={userHref(author.username)}
          >
            {author.name}
          </a>
        )}
        <span class="transcript-when">{clock(m.createdAt)}</span>
      </div>
      <div class="card transcript-card">
        {m.content}
        {m.uploads !== null && m.uploads.length > 0 && (
          <div class="transcript-files">
            {m.uploads.map((item, index) => (
              <FileChip
                // a record has no ids and never reorders
                key={index}
                name={item.name}
                archive={item.archive}
                note={
                  item.archive
                    ? plural(item.files, "file")
                    : sizeWords(item.bytes)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
