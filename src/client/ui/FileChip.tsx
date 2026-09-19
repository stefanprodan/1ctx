// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file as a small framed record: what it is, its name, and a faint
// word after it, its size or how many files an archive held. It opens
// nothing; a user message draws the files it carried with it.

import { Icon } from "../lib/icons.tsx";
import "./filechip.css";

export function FileChip({
  name,
  archive,
  note,
}: {
  name: string;
  archive: boolean;
  note: string;
}) {
  return (
    <span class="tag filechip" title={name}>
      <Icon
        name={archive ? "archive" : "file"}
        size={12}
        class="filechip-icon"
      />
      <span class="filechip-name cut">{name}</span>
      <span class="filechip-note cut">{note}</span>
    </span>
  );
}
