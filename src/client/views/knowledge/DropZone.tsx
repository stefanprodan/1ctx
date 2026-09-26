// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where files are dropped for the uploader, on the empty base and in
// the uploader itself, and the hidden input that chooses them, its
// keyboard way.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { Icon } from "../../lib/icons.tsx";

export function DropZone({
  title,
  empty,
  disabled,
  onFiles,
  children,
}: {
  title: string;
  // the base with no files yet
  empty?: boolean;
  // a drop is still taken, but not shown as welcome
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: ComponentChildren;
}) {
  const over = useSignal(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target
    <div
      class={`knowledge-drop${empty ? " knowledge-empty" : ""}${over.value ? " knowledge-drop-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) over.value = true;
      }}
      onDragLeave={() => {
        over.value = false;
      }}
      onDrop={(e) => {
        e.preventDefault();
        over.value = false;
        onFiles(Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      <Icon name="upload" size={20} class="knowledge-drop-icon" />
      <span class="knowledge-drop-main">{title}</span>
      {children}
    </div>
  );
}

export function ChooseFiles({
  class: klass,
  disabled,
  onFiles,
  children,
}: {
  class: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: ComponentChildren;
}) {
  return (
    <label class={`knowledge-choose ${klass}`}>
      {children}
      <input
        class="knowledge-file"
        type="file"
        multiple
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          onFiles(files);
        }}
      />
    </label>
  );
}
