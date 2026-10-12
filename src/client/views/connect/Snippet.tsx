// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A labelled box of text to paste elsewhere, with a copy button in its
// corner that says Copied for a moment.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { copyText } from "../../lib/clipboard.ts";
import { Icon } from "../../lib/icons.tsx";
import "./connect.css";

export function Snippet({
  label,
  text,
  hint,
}: {
  label: string;
  text: string;
  hint?: string;
}) {
  const copied: Signal<boolean> = useSignal(false);
  useEffect(() => {
    if (!copied.value) return;
    const timer = setTimeout(() => {
      copied.value = false;
    }, 1200);
    return () => clearTimeout(timer);
  }, [copied.value]);
  return (
    <div class="field">
      <span class="label">{label}</span>
      <div class="connect-snippet">
        <pre class="textbox connect-snippet-text">{text}</pre>
        <button
          type="button"
          class="btn-icon connect-snippet-copy"
          title={copied.value ? "Copied" : "Copy"}
          aria-label={`Copy ${label}`}
          onClick={() => {
            void copyText(text).then((ok) => {
              copied.value = ok;
            });
          }}
        >
          <Icon name={copied.value ? "check" : "copy"} size={14} />
        </button>
      </div>
      {hint !== undefined && <span class="hint">{hint}</span>}
    </div>
  );
}
