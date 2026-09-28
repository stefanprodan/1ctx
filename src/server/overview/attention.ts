// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Missing keys first: a send through them fails now.

import type { AttentionItem, AttentionKind } from "../../shared/api/admin.ts";
import type { KeyState } from "../../shared/contracts/credential.ts";

export type AttentionInput = {
  providers: { name: string; keyName: string | null; hasKey: boolean }[];
  mcp: {
    name: string;
    keyName: string | null;
    hasKey: boolean;
    refreshFailedAt: number | null;
  }[];
  skills: { name: string; refreshFailedAt: number | null }[];
  credentials: { name: string; key: KeyState }[];
  search: { provider: string | null; hasKey: boolean };
};

const KEY_ORDER: AttentionKind[] = [
  "provider-key",
  "mcp-key",
  "credential-key",
  "credential-unusable",
  "search-key",
];

export function attention(input: AttentionInput): AttentionItem[] {
  const keys: AttentionItem[] = [];
  const key = (kind: AttentionKind, name: string) =>
    keys.push({ kind, name, at: null });
  for (const p of input.providers) {
    if (p.keyName !== null && !p.hasKey) key("provider-key", p.name);
  }
  for (const s of input.mcp) {
    if (s.keyName !== null && !s.hasKey) key("mcp-key", s.name);
  }
  for (const c of input.credentials) {
    if (c.key === "missing") key("credential-key", c.name);
    if (c.key === "unusable") key("credential-unusable", c.name);
  }
  if (input.search.provider !== null && !input.search.hasKey) {
    key("search-key", input.search.provider);
  }
  keys.sort(
    (a, b) =>
      KEY_ORDER.indexOf(a.kind) - KEY_ORDER.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );
  const failed: AttentionItem[] = [
    ...input.mcp.flatMap((s) =>
      s.refreshFailedAt === null
        ? []
        : [
            {
              kind: "mcp-refresh" as const,
              name: s.name,
              at: s.refreshFailedAt,
            },
          ],
    ),
    ...input.skills.flatMap((s) =>
      s.refreshFailedAt === null
        ? []
        : [
            {
              kind: "skill-refresh" as const,
              name: s.name,
              at: s.refreshFailedAt,
            },
          ],
    ),
  ].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  return [...keys, ...failed];
}
