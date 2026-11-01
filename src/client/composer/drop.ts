// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's card as a drop target: files held over it light it,
// counted by how deep the pointer is in its children, since each child
// entered fires its own enter and leave; text dragged over is left to
// the box.

import type { Signal } from "@preact/signals";

export function dropTarget(
  over: Signal<number>,
  attach: (files: File[]) => void,
) {
  return {
    onDragEnter: (ev: DragEvent) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      over.value += 1;
    },
    onDragOver: (ev: DragEvent) => {
      if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
    },
    onDragLeave: () => {
      over.value = Math.max(0, over.value - 1);
    },
    onDrop: (ev: DragEvent) => {
      const dropped = [...(ev.dataTransfer?.files ?? [])];
      if (dropped.length === 0) return;
      ev.preventDefault();
      over.value = 0;
      attach(dropped);
    },
  };
}
