// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { ImageItem } from "../../../src/client/composer/Images.model.ts";
import { StagedImages } from "../../../src/client/composer/Images.tsx";
import { fitBox } from "../../../src/client/transcript/Images.model.ts";
import { QueuedRows } from "../../../src/client/transcript/Queued.tsx";
import { UserRow } from "../../../src/client/transcript/UserRow.tsx";
import { ViewerFocus } from "../../../src/client/ui/Viewer.model.ts";
import { Viewer } from "../../../src/client/ui/Viewer.tsx";
import type {
  Message,
  QueuedMessage,
} from "../../../src/shared/contracts/session.ts";
import type { MessageImage } from "../../../src/shared/images.ts";

const author = { name: "Casey", username: "casey" };

const shot = (id: string, changes: Partial<MessageImage> = {}) => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  width: 1600,
  height: 1200,
  freed: false,
  ...changes,
});

const message = (changes: Partial<Message>) =>
  ({
    id: "m1",
    kind: "user",
    content: "look",
    createdAt: 0,
    uploads: null,
    ...changes,
  }) as unknown as Message;

describe("a message's images", () => {
  test("fit inside the box at their own shape, never enlarged", () => {
    expect(fitBox(1600, 1200)).toEqual({ width: 320, height: 240 });
    expect(fitBox(1200, 1600)).toEqual({ width: 240, height: 320 });
    expect(fitBox(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fitBox(0, 0)).toEqual({ width: 320, height: 320 });
  });

  test("draw under the text with their size set, lazily, named by their alt", () => {
    const html = render(
      <UserRow
        projectId="p1"
        message={message({ images: [shot("im1")] })}
        author={author}
      />,
    );
    expect(html).toContain("transcript-card");
    expect(html).toContain('src="/api/projects/p1/images/im1"');
    expect(html).toContain('width="320"');
    expect(html).toContain('height="240"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('alt="im1.png"');
    expect(html.indexOf("look")).toBeLessThan(html.indexOf("images-pic"));
  });

  test("a freed image keeps its place as a line", () => {
    const html = render(
      <UserRow
        projectId="p1"
        message={message({ images: [shot("im1", { freed: true })] })}
        author={author}
      />,
    );
    expect(html).toContain("Image removed to free space");
    expect(html).not.toContain("<img");
  });

  test("a message of images alone has no empty text card", () => {
    const html = render(
      <UserRow
        projectId="p1"
        message={message({ content: "", images: [shot("im1")] })}
        author={author}
      />,
    );
    expect(html).not.toContain("transcript-card");
    expect(html).toContain("images-pic");
  });

  test("a queued message counts its images", () => {
    const row = {
      id: "q1",
      author: { id: "u1", username: "casey" },
      text: "",
      cut: false,
      uploads: 0,
      images: 2,
      state: "queued",
      reason: null,
      revision: 1,
      queuedAt: 0,
    } as unknown as QueuedMessage;
    const html = render(
      <QueuedRows
        rows={[row]}
        running
        userId="u1"
        editing={null}
        authorOf={() => author}
        onEdit={async () => {}}
        onRemove={async () => {}}
      />,
    );
    expect(html).toContain("2 images");
  });
});

describe("staged images in the draft", () => {
  const item = (changes: Partial<ImageItem>): ImageItem => ({
    key: 1,
    projectId: "p1",
    name: "shot.png",
    bytes: 10,
    phase: "staged",
    sent: 10,
    id: "im1",
    words: null,
    status: null,
    file: null,
    ...changes,
  });

  test("a staged one is a square thumbnail with its X, an upload its percent", () => {
    const html = render(
      <StagedImages
        items={[
          item({}),
          item({ key: 2, phase: "sending", id: null, sent: 4 }),
        ]}
        unread={false}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('src="/api/projects/p1/images/im1"');
    expect(html).toContain('width="56"');
    expect(html).toContain("40%");
    expect(html).toContain('aria-label="Remove shot.png"');
  });

  test("a refusal shows its words and status, and an agent without images a hint", () => {
    const html = render(
      <StagedImages
        items={[
          item({}),
          item({
            key: 2,
            phase: "refused",
            id: null,
            words: "SVG is not an image this server takes",
            status: 400,
          }),
        ]}
        unread
        onRemove={() => {}}
      />,
    );
    expect(html).toContain("SVG is not an image this server takes");
    expect(html).toContain("400");
    expect(html).toContain("This agent cannot read images");
  });
});

describe("the viewer", () => {
  test("is a modal dialog with the image and a close button", () => {
    const html = render(
      <Viewer
        src="/api/projects/p1/images/im1"
        alt="a.png"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('src="/api/projects/p1/images/im1"');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain("Download");
  });

  test("closes on Escape, keeps Tab on its button, and gives the focus back", () => {
    const focused: string[] = [];
    let closed = 0;
    const focus = new ViewerFocus(
      { focus: () => focused.push("image") },
      () => {
        closed += 1;
      },
    );
    const button = { focus: () => focused.push("close") };
    expect(focus.key("Tab", button)).toBe(true);
    expect(focus.key("a", button)).toBe(false);
    expect(focus.key("Escape", button)).toBe(true);
    expect(closed).toBe(1);
    focus.end();
    expect(focused).toEqual(["close", "image"]);
  });
});
