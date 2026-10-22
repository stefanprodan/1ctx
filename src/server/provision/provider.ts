// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Provider document over a held provider: the server never moves a
// provider to another wire, so a different one is refused offline rather
// than mid-apply, after earlier objects were written.

export function checkHeldWire(
  doc: { source: string; name: string; spec: { wire?: string } },
  // the held provider's wire, null when none is held by that name
  held: string | null,
): void {
  if (held === null || doc.spec.wire === undefined) return;
  if (doc.spec.wire !== held) {
    throw new Error(
      `${doc.source}: Provider/${doc.name}: spec.wire is ${held} and a provider's wire never changes`,
    );
  }
}
