// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message's text: plain as typed, with each fenced block drawn
// as code in the look of a reply's blocks. Built as elements, never
// HTML, since the text is the user's.

import { userParts } from "./UserText.model.ts";

// cut marks a text the frame shortened; its "…" never joins a fence line
export function UserText({
  text,
  cut = false,
}: {
  text: string;
  cut?: boolean;
}) {
  const parts = userParts(text);
  if (cut) {
    const last = parts.at(-1);
    if (last?.kind === "text")
      parts[parts.length - 1] = { ...last, text: `${last.text}…` };
    else parts.push({ kind: "text", text: "…" });
  }
  const only = parts[0];
  if (parts.length === 1 && only?.kind === "text") return <>{only.text}</>;
  return (
    <div class="transcript-text">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          // parts never reorder
          <div key={index}>{part.text}</div>
        ) : (
          <div key={index} class="transcript-fence">
            {part.lang !== "" && (
              <div class="md-block-head">
                <span class="md-block-lang">{part.lang}</span>
              </div>
            )}
            <pre class="md-pre">
              <code class="md-block-code">{part.text}</code>
            </pre>
          </div>
        ),
      )}
    </div>
  );
}
