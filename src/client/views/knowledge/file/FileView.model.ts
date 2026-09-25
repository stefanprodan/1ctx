// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a live file's head shows, apart from the view so the order is
// read without a DOM: one notice, a refusal first, then what asks, then
// what is news; and which buttons, none while something asks or the
// file is gone.

export type Mode = "read" | "edit" | "rename" | "delete";

export type NoticeKind =
  | "problem"
  | "delete"
  | "deleted"
  | "stale"
  | "conflict"
  | "restored"
  | "newer"
  | "draft"
  | "unbinned"
  | null;

export type ActionsKind = "none" | "edit" | "rename" | "revision" | "read";

export type HeadFacts = {
  mode: Mode;
  // a refusal the head shows
  problem: boolean;
  // the file went while the page was open
  deleted: boolean;
  // a read of the file again failed; the page keeps what it shows
  stale: boolean;
  // someone else's revision past the one the editor started from
  conflict: boolean;
  // someone else's revision the reader has not been shown
  newer: boolean;
  // an unsaved edit kept in this browser differs from the file
  draft: boolean;
  // the file is the revision this page's Restore just wrote
  restored: boolean;
  // the page was reached by a Restore from the bin (?restored)
  unbinned: boolean;
  // the file as it is, neither the history nor a past revision
  reading: boolean;
  revision: boolean;
};

export function noticeKind(facts: HeadFacts): NoticeKind {
  if (facts.problem) return "problem";
  if (facts.mode === "delete") return "delete";
  if (facts.deleted) return "deleted";
  if (facts.stale) return "stale";
  if (facts.conflict) return "conflict";
  if (facts.mode !== "read" || !facts.reading) return null;
  if (facts.restored) return "restored";
  if (facts.newer) return "newer";
  if (facts.draft) return "draft";
  if (facts.unbinned) return "unbinned";
  return null;
}

export function actionsKind(facts: HeadFacts): ActionsKind {
  if (facts.deleted || facts.mode === "delete") return "none";
  if (facts.mode === "edit") return "edit";
  if (facts.mode === "rename") return "rename";
  if (facts.revision) return "revision";
  return "read";
}

// the editor saves over the revision it started from, or, once told of
// someone else's, over theirs: Save anyway
export const saveRevision = (
  base: number,
  latest: number,
  conflict: boolean,
): number => (conflict ? latest : base);
