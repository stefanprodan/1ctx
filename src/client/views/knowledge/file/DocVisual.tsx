// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An HTML file drawn as a chat draws a visual, through the one player
// in transcript/Visual.tsx: the sandboxed shell at /api/visual, themed
// like the page, 680 wide and scrolling on a narrow screen. The text is
// drawn once, so a new revision is a new frame (the key says which).

import { Visual } from "../../../transcript/Visual.tsx";
import type { VisualCard } from "../../../transcript/visuals.ts";

export function DocVisual({
  fileId,
  revision,
  html,
  title,
}: {
  fileId: string;
  revision: number;
  html: string;
  title: string;
}) {
  const card: VisualCard = {
    key: `knowledge:${fileId}:${revision}`,
    messageId: "",
    callIndex: 0,
    title,
    result: null,
    // stored bytes, as an opened file's visual: no call to fail
    source: { kind: "file", index: 0 },
  };
  return (
    <div class="docpage-visual">
      <Visual key={card.key} card={card} text={{ title, html }} />
    </div>
  );
}
