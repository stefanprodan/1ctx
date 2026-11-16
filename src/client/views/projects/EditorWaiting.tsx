// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's editor while its project, agents and limit load: its
// first sections under their own words, beside the aside it lands with.

import type { ComponentChildren } from "preact";
import { SectionsWaiting } from "../../ui/Section.tsx";
import { Split } from "../../ui/Split.tsx";

export function EditorWaiting({ aside }: { aside: ComponentChildren }) {
  return (
    <Split aside={aside}>
      <SectionsWaiting
        label="Loading the editor"
        class="automations-editor"
        sections={[
          { title: "Name", text: "Unique in this project", fields: ["wide"] },
          {
            title: "Instructions",
            text: "The first message of every run",
            fields: ["prompt"],
            bare: true,
          },
          {
            title: "Memory",
            text: "What a run remembers",
            fields: ["seg-row", "text"],
            bare: true,
          },
          {
            title: "Needs attention",
            text: "Who decides a run must be flagged",
            fields: ["seg-row", "text"],
            bare: true,
          },
        ]}
      />
    </Split>
  );
}
