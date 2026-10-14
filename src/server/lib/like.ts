// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A search as a LIKE pattern: the query's text anywhere in the column,
// in any ASCII case, its wildcards taken as written.

// the clause after a column; its value is containing(q)
export const LIKE = "like ? escape '\\'";

export const containing = (q: string): string =>
  `%${q.replace(/[%_\\]/g, "\\$&")}%`;
