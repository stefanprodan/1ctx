// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The foot of an agent page's card that drafts: that a change waits,
// or the words the view puts in its place (a name taken), then Discard
// and Save, both off until something changed.

import type { ComponentChildren } from "preact";
import type { Save } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { SettingHint } from "../../ui/Setting.tsx";

export function DraftFoot({
  save,
  dirty,
  blocked,
  open,
  locked,
  hint,
  onDiscard,
}: {
  save: Save;
  dirty: boolean;
  // a draft that cannot be saved as it is: Save stays off
  blocked?: boolean;
  // an edit is open: Discard closes it though nothing changed yet
  open?: boolean;
  // another card of the page is saving
  locked?: boolean;
  // in place of the hint
  hint?: ComponentChildren;
  onDiscard: () => void;
}) {
  // nothing at rest; the words take a phone's line of their own
  const words = hint ?? (dirty ? "Unsaved changes" : undefined);
  return (
    <Foot
      save={save}
      dirty={dirty && !blocked && !locked}
      label="Save"
      stack={words !== undefined}
      start={<SettingHint>{words}</SettingHint>}
      before={
        <button
          type="button"
          class="btn"
          disabled={!(dirty || open) || save.busy || locked}
          onClick={() => {
            onDiscard();
            save.touch();
          }}
        >
          Discard
        </button>
      }
    />
  );
}
