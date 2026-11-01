// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message: who wrote it and when, then the text in a card, and
// inside the card the files it carried, as they were at the send, and
// under it the images. A message of images alone has no card. The name
// leads to the author's page when the author is known.

import type { Message } from "../../shared/contracts/session.ts";
import { clock, initials, stamp, uploadNote } from "../lib/format.ts";
import { userHref } from "../lib/hrefs.ts";
import { FileChip } from "../ui/FileChip.tsx";
import { MessageImages } from "./Images.tsx";
import { UserText } from "./UserText.tsx";

export function UserRow({
  projectId,
  message: m,
  author,
  channel = false,
}: {
  // the chat's, which the images are read from
  projectId: string;
  message: Message;
  author: { name: string; username: string | null };
  // a channel has no day lines, so each post says its day; a quote finds
  // it by its id
  channel?: boolean;
}) {
  const files = m.uploads ?? [];
  // the text may be blank only beside images
  const card = m.content !== "" || files.length > 0 || !m.images?.length;
  return (
    <div class="transcript-user" data-post={channel ? m.id : undefined}>
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
        <span class="transcript-when">
          {channel ? stamp(m.createdAt) : clock(m.createdAt)}
        </span>
      </div>
      {card && (
        <div class="card transcript-card">
          {m.content !== "" && <UserText text={m.content} />}
          {files.length > 0 && (
            <div class="transcript-files">
              {files.map((item, index) => (
                <FileChip
                  // a record has no ids and never reorders
                  key={index}
                  name={item.name}
                  archive={item.archive}
                  note={uploadNote(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {m.images !== undefined && (
        <MessageImages projectId={projectId} images={m.images} />
      )}
    </div>
  );
}
