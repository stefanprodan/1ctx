// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { AttachItem } from "../../../src/client/composer/Attach.state.ts";
import { Files } from "../../../src/client/composer/Files.tsx";
import { UserRow } from "../../../src/client/transcript/UserRow.tsx";
import { FileChip } from "../../../src/client/ui/FileChip.tsx";
import type { Message } from "../../../src/shared/contracts/session.ts";

const noop = () => {};

const item = (fields: Partial<AttachItem>): AttachItem => ({
  key: 1,
  projectId: "p1",
  name: "notes.md",
  archive: false,
  folder: "",
  bytes: 12,
  files: 1,
  attempt: "t1",
  phase: "staged",
  sent: 0,
  id: "up1",
  skip: null,
  since: 0,
  members: [],
  membersTotal: 0,
  file: null,
  ...fields,
});

describe("the files panel", () => {
  test("nothing added draws nothing", () => {
    expect(render(<Files items={[]} onRemove={noop} onClear={noop} />)).toBe(
      "",
    );
  });

  test("at rest it is one closed line with the clip and Remove all", () => {
    const html = render(
      <Files
        items={[
          item({}),
          item({
            key: 2,
            phase: "skipped",
            id: null,
            skip: { type: "expired" },
          }),
        ]}
        onRemove={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain("1 file attached");
    expect(html).toContain("1 skipped");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Remove all"');
    expect(html).toContain("composer-files-icon");
    expect(html).not.toContain("composer-files-spin");
    // closed: no list is drawn
    expect(html).not.toContain("rows-log");
  });

  test("while it uploads it spins and the X cancels too", () => {
    const html = render(
      <Files
        items={[item({ phase: "sending", id: null, sent: 6 })]}
        onRemove={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain("Uploading 1 of 1");
    expect(html).toContain("notes.md · 50%");
    expect(html).toContain("composer-files-spin");
    expect(html).toContain('aria-label="Cancel and remove all"');
  });
});

describe("a message's files", () => {
  test("a chip says what the file is and escapes its name", () => {
    const html = render(<FileChip name="<a>.zip" archive note="43 files" />);
    expect(html).toContain("&lt;a>.zip");
    expect(html).toContain("43 files");
  });

  test("the record is drawn inside the message card, none without one", () => {
    const message = {
      id: "m1",
      kind: "user",
      content: "look at these",
      createdAt: 0,
      uploads: [
        { name: "docs.zip", archive: true, files: 43, bytes: 9, saved: [] },
        { name: "notes.md", archive: false, files: 1, bytes: 2048, saved: [] },
      ],
    } as unknown as Message;
    const author = { name: "Casey", username: "casey" };
    const html = render(<UserRow message={message} author={author} />);
    const card = html.slice(html.indexOf("transcript-card"));
    expect(card).toContain("look at these");
    expect(card).toContain('class="transcript-files"');
    expect(card).toContain("43 files");
    expect(card).toContain("2 KB");
    expect(
      render(
        <UserRow message={{ ...message, uploads: null }} author={author} />,
      ),
    ).not.toContain("transcript-files");
  });
});
