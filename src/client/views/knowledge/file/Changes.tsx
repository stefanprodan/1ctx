// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a revision changed from the one before it: a band with the
// counts over the diff. A past revision's page draws it, and so does
// the file's own page for its latest revision, under the Changes icon.

import { useEffect, useMemo } from "preact/hooks";
import type {
  KnowledgeFileView,
  KnowledgeVersion,
} from "../../../../shared/contracts/knowledge.ts";
import {
  docVersions,
  historyHeld,
  historyOf,
  loadHistory,
  loadVersionView,
  versionOf,
} from "../../../data/knowledge-history.ts";
import { diffLines, type LineDiff } from "../../../lib/diff.ts";
import { sentence } from "../../../lib/format.ts";
import { Diff, DiffStat } from "../../../ui/Diff.tsx";

export function Changes({
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

// the newest kept revision under the file's own, which a history held
// from before the file's last write may not list yet
function beforeOf(
  versions: readonly KnowledgeVersion[],
  revision: number,
): KnowledgeVersion | null {
  return (
    versions.find(
      (version) => version.revision < revision && !version.deleted,
    ) ?? null
  );
}

// the history and the text the latest revision is compared with; a
// held history that stops short of the file is read again, since it may
// miss revisions written while the page was away
async function loadLatestChanges(file: KnowledgeFileView): Promise<void> {
  // a load in flight goes on to the text itself
  if (historyHeld(file.id) && historyOf(file.id).state === "loading") return;
  const held = historyOf(file.id);
  const behind =
    held.state === "done" && (held.versions[0]?.revision ?? 0) < file.revision;
  const versions = await loadHistory(file.projectId, file.id, behind);
  const before = versions === null ? null : beforeOf(versions, file.revision);
  // a text held or on its way is not read again; a failed one is
  const text = before === null ? null : docVersions.value.get(before.id);
  if (before !== null && (text === undefined || text?.state === "failed")) {
    await loadVersionView(file.projectId, before.id);
  }
}

// the file as it is against the revision before it
export function LatestChanges({ file }: { file: KnowledgeFileView }) {
  const history = historyOf(file.id);
  const before =
    history.state === "done" ? beforeOf(history.versions, file.revision) : null;
  const held = before === null ? null : versionOf(before.id);
  const beforeText = held?.state === "done" ? held.version.text : null;
  // once per pair of texts: the page draws again at every clock tick
  const diff = useMemo(
    () => (beforeText === null ? null : diffLines(beforeText, file.text)),
    [beforeText, file.text],
  );
  // again for a newer file, a history dropped from the cache, or one
  // another load brought in that names the revision before; never on a
  // load's own state, so a failed load is not retried in a loop
  const kept = historyHeld(file.id);
  useEffect(() => {
    void loadLatestChanges(file);
  }, [file, kept, before?.id]);
  if (history.state === "failed") {
    return (
      <p class="docpage-state">
        <span class="error">
          The history did not load. {sentence(history.failure.words)}
        </span>
      </p>
    );
  }
  if (history.state === "loading" || held?.state === "loading") {
    return <p class="docpage-state">Loading</p>;
  }
  if (before === null || held === null) {
    return <p class="docpage-state">No earlier revision is kept.</p>;
  }
  if (held.state === "failed") {
    return (
      <p class="docpage-state">
        <span class="error">
          Revision {before.revision} did not load.{" "}
          {sentence(held.failure.words)}
        </span>
      </p>
    );
  }
  if (diff === null || diff.tooLarge) {
    return <p class="docpage-state">Too large to compare.</p>;
  }
  return <Changes before={before.revision} after={file.revision} diff={diff} />;
}
