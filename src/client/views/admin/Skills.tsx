// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The skills: one card of rows, each a SKILL.md fetched from a URL.
// Add skill opens SkillForm.tsx at the top. A row opens in
// place to what the skill holds, the body and every file shown as the
// text an agent follows, never rendered, then Refresh and Delete,
// asked once in place.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import {
  bodies,
  deleteSkill,
  fileKey,
  files,
  readSkill,
  readSkillFile,
  refreshSkill,
  skills,
  skillsError,
} from "../../data/skills.ts";
import { reason } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsCard,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { SkillForm } from "./SkillForm.tsx";
import {
  bytesWord,
  changeLine,
  cutLines,
  droppedLine,
  firstSentence,
  metadataLines,
  metaLine,
  sourceLine,
} from "./Skills.model.ts";
import "./skills.css";

// a text loaded on open: the body or a file, as the bytes are
function Text({
  load,
  held,
}: {
  load: () => Promise<string>;
  held: string | undefined;
}) {
  const failure = useSignal<string | null>(null);
  const whole = useSignal(false);
  useEffect(() => {
    failure.value = null;
    if (held !== undefined) return;
    let current = true;
    load().catch((err) => {
      if (current) failure.value = reason(err);
    });
    return () => {
      current = false;
    };
  }, [held]);
  if (failure.value) return <p class="skills-state error">{failure.value}</p>;
  if (held === undefined) return <p class="skills-state">Loading</p>;
  const cut = whole.value ? { text: held, more: false } : cutLines(held);
  return (
    <>
      <pre class="skills-text">{cut.text}</pre>
      {cut.more && (
        <button
          type="button"
          class="btn btn-small skills-more"
          onClick={() => {
            whole.value = true;
          }}
        >
          Show more
        </button>
      )}
    </>
  );
}

function FileRow({
  skill,
  file,
  open,
  onToggle,
}: {
  skill: SkillSummary;
  file: { path: string; bytes: number };
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <span class="skills-path">{file.path}</span>
          <RowsMeta>{bytesWord(file.bytes)}</RowsMeta>
        </>
      }
    >
      <Text
        load={() => readSkillFile(skill.id, file.path)}
        held={files.value[fileKey(skill.id, file.path)]}
      />
    </RowsOpen>
  );
}

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: string | string[];
}) {
  return (
    <>
      <span class="skills-fact-label">{label}</span>
      <span class={`skills-fact${mono ? " skills-fact-mono" : ""}`}>
        {Array.isArray(children) ? children.join("\n") : children}
      </span>
    </>
  );
}

function SkillRow({
  skill,
  now,
  open,
  onToggle,
}: {
  skill: SkillSummary;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const openFile = useSignal<string | null>(null);
  const asking = useSignal(false);
  const busy = useSignal<"refresh" | "delete" | null>(null);
  const failure = useSignal<string | null>(null);
  const act = async (what: "refresh" | "delete") => {
    busy.value = what;
    failure.value = null;
    try {
      if (what === "refresh") await refreshSkill(skill.id);
      else await deleteSkill(skill.id);
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = null;
  };
  const meta = metaLine(skill, now);
  const dropped = droppedLine(skill);
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <RowsTitle
            name={skill.name}
            sub={firstSentence(skill.description)}
            mono
          />
          <RowsMeta bad={meta.bad}>{meta.text}</RowsMeta>
        </>
      }
    >
      <div class="skills-open">
        <div class="skills-facts">
          <Fact label="Description">{skill.description}</Fact>
          {skill.license !== "" && <Fact label="License">{skill.license}</Fact>}
          {skill.compatibility !== "" && (
            <Fact label="Compatibility">{skill.compatibility}</Fact>
          )}
          {Object.keys(skill.metadata).length > 0 && (
            <Fact label="Metadata" mono>
              {metadataLines(skill.metadata)}
            </Fact>
          )}
          {skill.allowedTools !== "" && (
            <Fact label="Allowed tools" mono>
              {skill.allowedTools}
            </Fact>
          )}
          <Fact label="Source" mono>
            {[sourceLine(skill), skill.sourceUrl]}
          </Fact>
          <Fact label="Agents">
            {skill.agents.length === 0 ? "None" : skill.agents.join(", ")}
          </Fact>
          <Fact label="Digest" mono>
            {`${skill.digest.slice(0, 12)} · ${changeLine(
              skill.lastChange,
              skill.fetchedAt,
              skill.createdAt,
            )}`}
          </Fact>
          {skill.refreshError !== null && (
            <Fact label="Refresh">{skill.refreshError}</Fact>
          )}
        </div>
        <span class="label">SKILL.md</span>
        <Text load={() => readSkill(skill.id)} held={bodies.value[skill.id]} />
        {skill.files.length > 0 && (
          <>
            <span class="label">Files</span>
            <div class="skills-files">
              {skill.files.map((file) => (
                <FileRow
                  key={file.path}
                  skill={skill}
                  file={file}
                  open={openFile.value === file.path}
                  onToggle={() => {
                    openFile.value =
                      openFile.value === file.path ? null : file.path;
                  }}
                />
              ))}
            </div>
          </>
        )}
        {dropped !== "" && <p class="skills-state">{dropped}</p>}
        <div class="skills-actions">
          {asking.value ? (
            <>
              <span class="skills-ask">Delete {skill.name}?</span>
              <button
                type="button"
                class="btn btn-small btn-danger"
                disabled={busy.value !== null}
                onClick={() => void act("delete")}
              >
                {busy.value === "delete" ? "Deleting" : "Delete"}
              </button>
              <button
                type="button"
                class="btn btn-small"
                disabled={busy.value !== null}
                onClick={() => {
                  asking.value = false;
                  failure.value = null;
                }}
              >
                Keep
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                class="btn btn-small"
                disabled={busy.value !== null}
                onClick={() => void act("refresh")}
              >
                {busy.value === "refresh" ? "Refreshing" : "Refresh"}
              </button>
              <button
                type="button"
                class="btn btn-small"
                disabled={busy.value !== null}
                onClick={() => {
                  asking.value = true;
                  failure.value = null;
                }}
              >
                Delete
              </button>
            </>
          )}
          {failure.value && (
            <span class="skills-note error">{failure.value}</span>
          )}
        </div>
      </div>
    </RowsOpen>
  );
}

export function Skills() {
  const list = skills.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const error = skillsError.value;
  // the fetched-ago words move by the minute
  const now = useSignal(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Page
      crumb="Admin"
      title="Skills"
      loading={list === null && error === null}
      error={error}
    >
      <Rows>
        <RowsCard
          label="Skills"
          hint="An agent's skills apply to its next send"
          action={
            <RowsAdd
              label="Add skill"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            />
          }
        >
          {adding.value && (
            <RowsNew>
              <SkillForm
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {list?.length === 0 && !adding.value && (
            <RowsNote>
              No skills yet. Add skill takes a URL and keeps what it finds
              there.
            </RowsNote>
          )}
          {(list ?? []).map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              now={now.value}
              open={open.value === skill.id}
              onToggle={() => {
                open.value = open.value === skill.id ? null : skill.id;
                adding.value = false;
              }}
            />
          ))}
        </RowsCard>
      </Rows>
    </Page>
  );
}
