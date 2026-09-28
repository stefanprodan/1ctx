// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { type Save, useArrivalFocus, useFocusField } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";

export function NewCard({
  label,
  create,
  cancel,
  save,
  ready,
  taken,
  first,
  onSubmit,
  class: owner,
  children,
}: {
  label: string;
  create: string;
  cancel: string;
  save: Save;
  ready: boolean;
  taken: string | null;
  first: string;
  onSubmit: () => void;
  class?: string;
  children: ComponentChildren;
}) {
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  useArrivalFocus(form, first);
  return (
    <form
      ref={form}
      class={`setting-stack${owner ? ` ${owner}` : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Setting
        label={label}
        foot={
          <Foot
            save={save}
            dirty={ready && taken === null}
            label={create}
            stack={taken !== null}
            start={
              <SettingHint>
                {taken !== null && <span class="error">{taken} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href={cancel}>
                Cancel
              </a>
            }
          />
        }
      >
        {children}
      </Setting>
    </form>
  );
}
