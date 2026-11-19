// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The input's names: one document per kind and name, one of each
// instance-wide kind, and one default of a kind.

type Named = {
  source: string;
  kind: string;
  name: string;
  spec: object;
};

// the kinds an instance holds one of; any name updates the one held
const SINGLE_KINDS = ["SmtpServer", "Dictation", "Sandbox"] as const;

export function duplicate(documents: readonly Named[]): void {
  const seen = new Map<string, string>();
  for (const doc of documents) {
    const key = `${doc.kind}/${doc.name}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `${doc.source}: ${key}: metadata.name is duplicated (first in ${previous})`,
      );
    }
    seen.set(key, doc.source);
  }
  for (const kind of SINGLE_KINDS) {
    const [first, second] = documents.filter((doc) => doc.kind === kind);
    if (second !== undefined) {
      throw new Error(
        `${second.source}: ${kind}/${second.name}: one ${kind} object per instance (first ${kind}/${first!.name})`,
      );
    }
  }
  // one default of a kind, since a second would take the mark from the
  // first
  for (const kind of ["Agent", "Decider"] as const) {
    let marked: Named | null = null;
    for (const doc of documents) {
      const marks = (doc.spec as { default?: unknown }).default === true;
      if (doc.kind !== kind || !marks) continue;
      if (marked !== null) {
        throw new Error(
          `${doc.source}: ${kind}/${doc.name}: spec.default is also set on ${kind}/${marked.name}`,
        );
      }
      marked = doc;
    }
  }
}
