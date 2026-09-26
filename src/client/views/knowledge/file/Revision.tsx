// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A past revision in the file's card: the ‹ › steps to its neighbours,
// who wrote it and when, then what it changed from the revision before
// it, or its text, Markdown rendered or as its source. A change too
// large to compare offers the text only.

import { useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import type {
  KnowledgeFileView,
  KnowledgeVersionView,
} from "../../../../shared/contracts/knowledge.ts";
import { type DocHistory, versionOf } from "../../../data/knowledge-history.ts";
import { revisionPair } from "../../../data/knowledge-rows.ts";
import { diffLines, type LineDiff } from "../../../lib/diff.ts";
import { ago, sentence } from "../../../lib/format.ts";
import { Icon } from "../../../lib/icons.tsx";
import { Diff, DiffStat } from "../../../ui/Diff.tsx";
import { Seg } from "../../../ui/Seg.tsx";
import { Source } from "../../../ui/Source.tsx";
import { Author } from "../Author.tsx";
import { authorOf, historyHref, revisionHref } from "../Knowledge.model.ts";
import { revisionSteps } from "./DocPage.model.ts";
import { MarkdownBody } from "./Reader.tsx";

type Showing = "changes" | "preview" | "source" | "text";

const SHOWING: Record<Showing, string> = {
  changes: "Changes",
  preview: "Preview",
  source: "Source",
  text: "Text",
};

// the version on the page, once its text is read, for the head's Restore
export function revisionView(
  history: DocHistory,
  revision: number,
): KnowledgeVersionView | null {
  if (history.state !== "done") return null;
  const { version } = revisionPair(history.versions, revision);
  if (version === null) return null;
  const view = versionOf(version.id);
  return view.state === "done" ? view.version : null;
}

// what the revision changed, once its diff is known and comparable
function Changes({
  before,
  after,
  diff,
}: {
  before: number;
  after: number;
  diff: Extract<LineDiff, { tooLarge: false }>;
}) {
  return (
    <>
      <div class="docpage-band">
        <span class="docpage-band-words">
          What revision {after} changed from revision {before}
        </span>
        <DiffStat added={diff.added} removed={diff.removed} />
      </div>
      <Diff diff={diff} />
    </>
  );
}

export function Revision({
  file,
  history,
  revision,
  now,
}: {
  file: KnowledgeFileView;
  history: DocHistory;
  revision: number;
  now: number;
}) {
  const mode = useSignal<Showing | null>(null);
  const pair =
    history.state === "done"
      ? revisionPair(history.versions, revision)
      : { version: null, before: null };
  const view = pair.version === null ? null : versionOf(pair.version.id);
  const before = pair.before === null ? null : versionOf(pair.before.id);
  const beforeText = before?.state === "done" ? before.version.text : null;
  const afterText = view?.state === "done" ? view.version.text : null;
  // once per pair of texts: the page draws again at every clock tick
  const diff = useMemo(
    () =>
      beforeText === null || afterText === null
        ? null
        : diffLines(beforeText, afterText),
    [beforeText, afterText],
  );
  if (history.state !== "done") {
    return (
      <p class="docpage-state">
        {history.state === "loading" ? (
          "Loading"
        ) : (
          <span class="error">
            The history did not load. {sentence(history.failure.words)}
          </span>
        )}
      </p>
    );
  }
  if (pair.version === null || view === null) {
    return (
      <p class="docpage-state">
        Revision {revision} is not kept.{" "}
        <a class="docpage-link" href={historyHref(file.projectId, file.id)}>
          Open the history
        </a>
      </p>
    );
  }
  const steps = revisionSteps(history.versions, revision);
  const tooLarge = diff?.tooLarge === true;
  // the first revision has nothing to compare with; Markdown reads as
  // the live file does, rendered or as its source
  const comparable = pair.before !== null && !tooLarge;
  const markdown = view.state === "done" && view.version.html !== null;
  const options: Showing[] = [
    ...(comparable ? (["changes"] as const) : []),
    ...(markdown ? (["preview", "source"] as const) : (["text"] as const)),
  ];
  const showing =
    mode.value !== null && options.includes(mode.value)
      ? mode.value
      : options[0];
  return (
    <>
      <div class="docpage-band docpage-band-rev">
        <span class="docpage-steps">
          <a
            class={`btn-icon${steps.older === null ? " docpage-off" : ""}`}
            aria-label="Older revision"
            aria-disabled={steps.older === null}
            href={
              steps.older === null
                ? undefined
                : revisionHref(file.projectId, file.id, steps.older)
            }
          >
            <Icon name="chevron-left" size={14} />
          </a>
          <span class="docpage-strong">
            Revision {revision} of {file.revision}
          </span>
          <a
            class={`btn-icon${steps.newer === null ? " docpage-off" : ""}`}
            aria-label="Newer revision"
            aria-disabled={steps.newer === null}
            href={
              steps.newer === null
                ? undefined
                : revisionHref(
                    file.projectId,
                    file.id,
                    steps.newer,
                    file.revision,
                  )
            }
          >
            <Icon name="chevron-right" size={14} />
          </a>
        </span>
        <span class="docpage-band-words">
          <Author words={authorOf(pair.version.author)} /> ·{" "}
          {ago(pair.version.writtenAt, now)}
          {tooLarge && " · Too large to compare"}
        </span>
        {options.length > 1 && (
          <Seg
            label="Show"
            small
            options={options.map((value) => ({
              value,
              label: SHOWING[value],
            }))}
            value={showing}
            onPick={(value) => {
              mode.value = value;
            }}
          />
        )}
      </div>
      {view.state === "loading" ||
      (showing === "changes" && before?.state === "loading") ? (
        <p class="docpage-state">Loading</p>
      ) : view.state === "failed" ? (
        <p class="docpage-state">
          <span class="error">
            This revision did not load. {sentence(view.failure.words)}
          </span>
        </p>
      ) : showing === "changes" &&
        before?.state === "done" &&
        diff !== null &&
        !diff.tooLarge ? (
        <Changes
          before={before.version.revision}
          after={view.version.revision}
          diff={diff}
        />
      ) : showing === "preview" ? (
        <MarkdownBody html={view.version.html ?? ""} />
      ) : (
        <Source text={view.version.text} html={view.version.code} />
      )}
    </>
  );
}
