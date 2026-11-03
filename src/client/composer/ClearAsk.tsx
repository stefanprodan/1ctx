// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /clear's question under the box: it cannot be undone and every member
// loses the history, so only Delete sends it. Keep, Escape or a key in
// the box puts it away, and so does its answer. Done, the box empties
// unless it was typed in since; refused, the words show as any refused
// command's.

import type { Signal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { says } from "../lib/format.ts";
import { useSave } from "../lib/save.ts";
import { touch } from "../lib/touch.ts";
import { AskDelete } from "../ui/Foot.tsx";
import { writeDraftText } from "./draft.ts";

// what Enter on /clear runs: the question, never the delete, with the
// menu put away so it never covers the question
export const askClear =
  (asking: Signal<boolean>, shut: Signal<boolean>) => async () => {
    asking.value = true;
    shut.value = true;
  };

// the question answered or put away: the cursor back in the box, since
// the button that had focus is gone
export function useAskFocus(
  asking: Signal<boolean>,
  input: RefObject<HTMLTextAreaElement | null>,
): void {
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !asking.value && !touch()) input.current?.focus();
    was.current = asking.value;
  }, [asking.value]);
}

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
