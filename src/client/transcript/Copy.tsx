// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Copy button under a turn, a check for a moment after a copy. A
// page without clipboard access leaves the button as it is.

import { useEffect, useState } from "preact/hooks";
import { copyText } from "../lib/clipboard.ts";
import { Icon } from "../lib/icons.tsx";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      class={`transcript-act${copied ? " transcript-act-done" : ""}`}
      title="Copy"
      aria-label="Copy"
      onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}
