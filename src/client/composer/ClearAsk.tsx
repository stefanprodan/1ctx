// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /clear's question under the box: it cannot be undone and every member
// loses the history, so only Delete sends it. Keep, Escape or a key in
// the box puts it away, and so does its answer. Done, the box empties
// unless it was typed in since; refused, the words show as any refused
// command's.

import type { Signal } from "@preact/signals";
import { says } from "../lib/format.ts";
import { useSave } from "../lib/save.ts";
import { AskDelete } from "../ui/Foot.tsx";
import { writeDraftText } from "./draft.ts";

// what Enter on /clear runs: the question, never the delete
export const askClear = (asking: Signal<boolean>) => async () => {
  asking.value = true;
};

export function ClearAsk({
  name,
  asking,
  onClear,
  box,
}: {
  // the channel by name ("#finops")
  name: string;
  asking: Signal<boolean>;
  onClear: () => Promise<void>;
  box: { key: string; text: Signal<string>; failure: Signal<string | null> };
}) {
  const save = useSave(async () => {});
  return (
    <div class="composer-ask">
      <AskDelete
        save={save}
        asking={asking}
        busy={save.busy}
        words={`Delete every message in ${name}?`}
        wordsClass="composer-ask-words"
        action="clear"
        small
        onDelete={() => {
          void save.act("clear", async () => {
            try {
              await onClear();
              if (box.text.value.trim() === "/clear") {
                box.text.value = "";
                writeDraftText(box.key, "");
              }
            } catch (err) {
              box.failure.value = says(err);
            }
            asking.value = false;
          });
        }}
      />
    </div>
  );
}
