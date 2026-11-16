// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
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
import { useCut } from "../../lib/resize.ts";
import { LinesWaiting } from "../../ui/Bones.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { RowsMeta, RowsNote, RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { droppedLine, TEXT_LINES, textBox } from "./Skills.model.ts";

// SKILL.md's box while it loads, at the cut box's lines, so the Files
// card under it stays put when the text lands cut with Show all
export function SkillTextWaiting({ label }: { label?: string }) {
  return <LinesWaiting class="textbox" lines={TEXT_LINES} label={label} />;
}

export function SkillFiles({ skill }: { skill: SkillSummary }) {
  const open = useSignal<string | null>(null);
  const dropped = droppedLine(skill);
  return (
    <>
      <Setting title="SKILL.md" count={size(skill.bodyBytes)}>
        <Text
          name="SKILL.md"
          load={() => readSkill(skill.id)}
          held={bodies.value[skill.id]}
          ground="card"
          waiting={<SkillTextWaiting label="Loading SKILL.md" />}
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
                name={file.path}
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
  name,
  load,
  held,
  ground,
  waiting,
}: {
  name: string;
  load: () => Promise<string>;
  held: string | undefined;
  ground?: "card";
  // its own shape while it loads, else a few lines
  waiting?: ComponentChildren;
}) {
  const failure = useSignal<string | null>(null);
  const { el, open, long } = useCut<HTMLPreElement>([held]);
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
  if (held === undefined) {
    if (waiting !== undefined) return waiting;
    return (
      <LinesWaiting
        class="skill-page-state"
        lines={6}
        label={`Loading ${name}`}
      />
    );
  }
  // cut, not scrolled: a box scrolling inside the page leaves the
  // sticky head behind. Cut at its first lines and at their height
  // too, so a long line wrapping on a phone never makes the box taller
  // than its wait
  const box = textBox(held, open.value);
  return (
    <Fold
      cut={(box.cut || long.value) && !open.value}
      onOpen={() => {
        open.value = true;
      }}
      label={box.label}
      framed
      ground={ground}
    >
      <pre ref={el} class={`textbox${open.value ? "" : " skill-page-clip"}`}>
        {box.text}
      </pre>
    </Fold>
  );
}
