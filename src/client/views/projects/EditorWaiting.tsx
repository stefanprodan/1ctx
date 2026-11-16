// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's editor while its project, agents and limit load: its
// first sections under their own words, beside the aside it lands with.

import type { ComponentChildren } from "preact";
import { Bone } from "../../ui/Bones.tsx";
import { SectionsWaiting } from "../../ui/Section.tsx";
import { Split } from "../../ui/Split.tsx";
import { EDITOR_TEXT } from "./AutomationEdit.model.ts";
import "./automations.css";

// a switch over the box of guidance it opens, as the Memory and Needs
// attention sections land
function Guided({ at, rows }: { at: number; rows: number }) {
  return (
    <div class="field">
      <Bone kind="seg" at={at} />
      <span class="field automations-guidance">
        <Bone kind="rows" at={at + 1} rows={rows} />
      </span>
    </div>
  );
}

export function EditorWaiting({ aside }: { aside: ComponentChildren }) {
  return (
    <Split aside={aside}>
      <SectionsWaiting
        label="Loading the editor"
        class="automations-editor"
        sections={[
          { title: "Name", text: EDITOR_TEXT.name, fields: ["wide"] },
          {
            title: "Instructions",
            text: EDITOR_TEXT.instructions,
            body: (
              <div class="field">
                <div class="automations-instructions">
                  <Bone
                    kind="rows"
                    at={4}
                    rows={5}
                    class="automations-instructions-bone"
                  />
                  <div class="automations-instructions-bar">
                    <Bone kind="button" at={5} class="automations-agent-bone" />
                  </div>
                </div>
              </div>
            ),
          },
          {
            title: "Memory",
            text: EDITOR_TEXT.memory,
            body: <Guided at={8} rows={4} />,
          },
          {
            title: "Needs attention",
            text: EDITOR_TEXT.attention,
            body: <Guided at={12} rows={3} />,
          },
        ]}
      />
    </Split>
  );
}
