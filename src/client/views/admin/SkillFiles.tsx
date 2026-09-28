// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import {
  bodies,
  fileKey,
  files,
  readSkill,
  readSkillFile,
} from "../../data/skills.ts";
import { says, size } from "../../lib/format.ts";
import { Fold } from "../../ui/Fold.tsx";
import { RowsMeta, RowsNote, RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { droppedLine, textBox } from "./Skills.model.ts";

export function SkillFiles({ skill }: { skill: SkillSummary }) {
  const open = useSignal<string | null>(null);
  const dropped = droppedLine(skill);
  return (
    <>
      <Setting title="SKILL.md" count={size(skill.bodyBytes)}>
        <Text
          load={() => readSkill(skill.id)}
          held={bodies.value[skill.id]}
          ground="card"
        />
      </Setting>
      {(skill.files.length > 0 || dropped !== "") && (
        // no count: the tab has it
        <Setting list title="Files">
          {skill.files.map((file) => (
            <RowsOpen
              key={file.path}
              open={open.value === file.path}
              onToggle={() => {
                open.value = open.value === file.path ? null : file.path;
              }}
              indent="chevron"
              head={
                <>
                  <RowsTitle name={file.path} mono />
                  <RowsMeta>{size(file.bytes)}</RowsMeta>
                </>
              }
            >
              <Text
                load={() => readSkillFile(skill.id, file.path)}
                held={files.value[fileKey(skill.id, file.path)]}
              />
            </RowsOpen>
          ))}
          {dropped !== "" && <RowsNote>{dropped}</RowsNote>}
        </Setting>
      )}
    </>
  );
}

function Text({
  load,
  held,
  ground,
}: {
  load: () => Promise<string>;
  held: string | undefined;
  ground?: "card";
}) {
  const failure = useSignal<string | null>(null);
  const expanded = useSignal(false);
  useEffect(() => {
    failure.value = null;
    if (held !== undefined) return;
    let current = true;
    load().catch((err) => {
      if (current) failure.value = says(err);
    });
    return () => {
      current = false;
    };
  }, [held]);
  if (failure.value) {
    return <p class="skill-page-state error">{failure.value}</p>;
  }
  if (held === undefined) return <p class="skill-page-state">Loading</p>;
  // cut, not scrolled: a box scrolling inside the page leaves the
  // sticky head behind
  const box = textBox(held, expanded.value);
  return (
    <Fold
      cut={box.cut && !expanded.value}
      onOpen={() => {
        expanded.value = true;
      }}
      label={box.label}
      framed
      ground={ground}
    >
      <pre class="textbox">{box.text}</pre>
    </Fold>
  );
}
