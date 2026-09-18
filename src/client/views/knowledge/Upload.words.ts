// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the uploader says: each picked item, each run line, the head over
// the bar and the skipped log, from the state and the server's answers.

import { plural, sizeWords } from "./Knowledge.model.ts";
import type { Skip, UploadItem, UploadState } from "./Upload.state.ts";

export const FOLDER_HINT =
  "The root when empty. Names are saved lowercase with dashes, so My Docs/On Call.md becomes my-docs/on-call.md";
export function skipWords(reason: Skip): string {
  const words: Record<Skip, string> = {
    "not-regular": "not a regular file",
    outside: "outside the folder",
    "no-letters": "no letters or digits",
    "too-long": "name too long",
    "bad-name": "bad name",
    duplicate: "duplicate name",
    "too-big": "over the file limit",
    "not-text": "not text",
    clash: "clashes with another",
    "clash-live": "clashes with a file",
    "upload-size": "over the 32 MB upload limit",
  };
  return words[reason];
}
export function pickedWords(item: UploadItem): string {
  if (item.outcome?.type === "skipped") return skipWords(item.outcome.reason);
  const kind =
    item.kind === "text"
      ? "text file"
      : `${item.kind === "gzip" ? "tar.gz" : item.kind} archive`;
  return `${kind} · ${sizeWords(item.file.size)}${item.kind === "text" && item.name !== item.file.name ? ` · saved as ${item.name}` : ""}`;
}

export function byteProgress(sent: number, total: number): string {
  const unit = total < 1024 ? 1 : total < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${Number((sent / unit).toPrecision(3))} of ${sizeWords(total)}`;
}

export function itemWords(item: UploadItem): {
  note: string;
  bad?: boolean;
  running?: boolean;
  status?: number;
} {
  const outcome = item.outcome;
  if (!outcome)
    return {
      note:
        item.phase === "sending"
          ? `sending, ${byteProgress(item.sent, item.file.size)}`
          : item.phase,
      running: item.phase === "sending" || item.phase === "saving",
    };
  if (outcome.type === "skipped") return { note: skipWords(outcome.reason) };
  if (outcome.type === "not-sent") return { note: "not sent" };
  if (outcome.type === "uncertain") return { note: "stopped, may have saved" };
  if (outcome.type === "failed")
    return outcome.problem.field
      ? { note: "not saved" }
      : {
          note: outcome.problem.error,
          bad: true,
          status: outcome.problem.status,
        };
  const r = outcome.result;
  if (item.kind === "text") {
    if (r.added) return { note: `added ${r.saved[0]}` };
    if (r.replaced) return { note: `replaced ${r.saved[0]}` };
    return { note: r.unchanged ? "unchanged" : "skipped" };
  }
  const counts = [
    [r.added, "added"],
    [r.replaced, "replaced"],
    [r.unchanged, "unchanged"],
    [r.skippedTotal, "skipped"],
  ] as const;
  return {
    note:
      counts
        .filter(([n]) => n > 0)
        .map(([n, word]) => `${n} ${word}`)
        .join(" · ") || "no files",
  };
}

export function uploadTotals(items: readonly UploadItem[]) {
  const total = {
    added: 0,
    replaced: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    sent: 0,
    files: 0,
  };
  for (const item of items) {
    const o = item.outcome;
    if (o?.type === "skipped") {
      total.skipped++;
      continue;
    }
    total.bytes += item.file.size;
    total.sent += item.sent;
    total.files++;
    if (o?.type === "failed") total.failed++;
    if (o?.type === "written" || o?.type === "unchanged") {
      total.added += o.result.added;
      total.replaced += o.result.replaced;
      total.unchanged += o.result.unchanged;
      total.skipped += o.result.skippedTotal;
    }
  }
  return total;
}

export function progressWords(state: UploadState) {
  const totals = uploadTotals(state.items.value);
  const done = state.phase.value === "done";
  const index = state.ready.findIndex(
    (item) => item.phase === "sending" || item.phase === "saving",
  );
  const current = state.ready[index];
  return {
    title: done
      ? totals.added + totals.replaced > 0
        ? `Saved ${plural(totals.added + totals.replaced, "file")}`
        : "Nothing saved"
      : current
        ? `Uploading ${index + 1} of ${totals.files}`
        : "Finishing",
    // a count of none says nothing, so only the counts that happened show
    detail: done
      ? (
          [
            [totals.added, "added"],
            [totals.replaced, "replaced"],
            [totals.unchanged, "unchanged"],
          ] as const
        )
          .filter(([count]) => count > 0)
          .map(([count, word]) => `${count} ${word}`)
          .join(", ")
      : (current?.file.name ?? ""),
    failed: totals.failed ? `${plural(totals.failed, "upload")} failed` : "",
    aside: done
      ? `${totals.skipped} skipped`
      : byteProgress(totals.sent, totals.bytes),
    percent: done ? 100 : totals.bytes ? (totals.sent / totals.bytes) * 100 : 0,
  };
}

export function skippedLog(items: readonly UploadItem[], all: boolean) {
  const groups: {
    name: string;
    lines: { name: string; note: string }[];
    more: string | null;
  }[] = [];
  let remaining = all ? Infinity : 10;
  for (const item of items) {
    const o = item.outcome;
    if (o?.type !== "written" && o?.type !== "unchanged") continue;
    const lines = o.result.skipped
      .slice(0, remaining)
      .map((s) => ({ name: s.name, note: skipWords(s.reason) }));
    remaining -= lines.length;
    const extra = o.result.skippedTotal - o.result.skipped.length;
    const more =
      extra > 0 && (all || remaining > 0)
        ? `and ${extra} more in ${item.file.name}`
        : null;
    if (lines.length || more)
      groups.push({ name: item.file.name, lines, more });
  }
  const picked = items.filter((item) => item.outcome?.type === "skipped");
  const lines = picked
    .slice(0, remaining)
    .map((item) => ({ name: item.file.name, note: itemWords(item).note }));
  if (lines.length) groups.push({ name: "Picked", lines, more: null });
  return { groups, total: uploadTotals(items).skipped };
}
