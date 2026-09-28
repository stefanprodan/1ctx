// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
  blocked?: boolean;
  // Discard closes an open edit with nothing changed
  open?: boolean;
  locked?: boolean;
  hint?: ComponentChildren;
  onDiscard: () => void;
}) {
  const words = hint ?? (dirty ? "Unsaved changes" : undefined);
  return (
    <Foot
      save={save}
      dirty={dirty && !blocked && !locked}
      label="Save"
      inline
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
