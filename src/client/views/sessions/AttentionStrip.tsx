// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Why a run needs attention, the top of its foot, so it stays in view
// at any scroll: one line with the reason cut, opened in place to read
// it whole. The runner's reason shows too, since this is the one place
// the foot says it. With no reason there is nothing to open, and a
// decider's mark names the decider. While the
// run is one of its automation's open alert, Dismiss closes the alert:
// a button of its own beside the line, so it never opens the strip.

import { useSignal } from "@preact/signals";
import { Icon } from "../../lib/icons.tsx";

const TITLE = "Needs attention";

export function AttentionStrip({
  reason,
  by = null,
  onDismiss,
}: {
  reason: string | null;
  by?: string | null;
  onDismiss?: () => void;
}) {
  const open = useSignal(false);
  return (
    <AttentionLine
      reason={reason}
      by={by}
      open={open.value}
      onToggle={() => {
        open.value = !open.value;
      }}
      onDismiss={onDismiss}
    />
  );
}

// the strip as drawn, its open state held by the caller
export function AttentionLine({
  reason,
  by = null,
  open,
  onToggle,
  onDismiss,
}: {
  reason: string | null;
  by?: string | null;
  open: boolean;
  onToggle: () => void;
  onDismiss?: () => void;
}) {
  const dismiss = onDismiss !== undefined && (
    <button
      type="button"
      class="btn-text chat-attention-dismiss"
      onClick={onDismiss}
    >
      Dismiss
    </button>
  );
  if (reason === null) {
    return (
      <div class="chat-attention">
        <span class="chat-attention-line">
          <Icon name="alert" size={14} class="chat-attention-icon" />
          <span class="chat-attention-text">
            <span class="chat-attention-title">{TITLE}</span>
            {by !== null && (
              <>
                {" "}
                <span class="chat-attention-by">
                  · flagged by the @{by} decider
                </span>
              </>
            )}
          </span>
        </span>
        {dismiss}
      </div>
    );
  }
  return (
    <div class={`chat-attention${open ? " chat-attention-open" : ""}`}>
      <button
        type="button"
        class="chat-attention-line chat-attention-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="alert" size={14} class="chat-attention-icon" />
        <span class="chat-attention-text">
          {/* a real space, so the button's name reads as two words */}
          <span class="chat-attention-title">{TITLE}</span> {reason}
        </span>
        <Icon name="chevron" size={12} class="chat-attention-chevron" />
      </button>
      {dismiss}
    </div>
  );
}
