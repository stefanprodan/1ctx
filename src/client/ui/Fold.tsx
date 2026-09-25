// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A block cut to its first lines: its foot fades into the ground it
// sits on, with Show all inside the fade where the cut lands. Once open
// it stays whole; the row or the fold around it folds it again. The
// owner cuts the block (a clip class measured by useCut, or its text
// sliced by a count of lines); `framed` draws the block's border round
// the foot, since a cut hides the bottom edge of a boxed block. Never a
// scroll box of its own: one that comes and goes inside the shell's
// scroll box leaves Chrome's stuck head and foot riding with the rows.
// Show all goes once pressed, so the focus moves to the block it opened
// rather than falling to the page.

import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import "./fold.css";

export function Fold({
  cut,
  onOpen,
  label,
  framed,
  ground = "inset",
  children,
}: {
  // the cut hides something: the fade and Show all are drawn
  cut: boolean;
  onOpen: () => void;
  label: string;
  framed?: boolean;
  // what the block sits on, which the fade ends in
  ground?: "inset" | "card" | "page";
  children: ComponentChildren;
}) {
  const block = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={block}
      class={`fold fold-${ground}${framed ? " fold-framed" : ""}`}
      tabIndex={-1}
    >
      {children}
      {cut && (
        <div class="fold-more">
          <button
            type="button"
            class="btn-text"
            onClick={() => {
              onOpen();
              block.current?.focus({ preventScroll: true });
            }}
          >
            {label}
          </button>
        </div>
      )}
    </div>
  );
}
