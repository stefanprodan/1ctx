// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The status beside a failure's words, nothing when the server did not
// answer. `spaced` puts a space before it, for words it follows inline.

export function CodeTag({
  status,
  spaced,
  class: extra,
}: {
  status: number | null | undefined;
  spaced?: boolean;
  class?: string;
}) {
  if (status === null || status === undefined) return null;
  const tag = (
    <span class={`code-tag${extra ? ` ${extra}` : ""}`}>HTTP {status}</span>
  );
  return spaced ? <> {tag}</> : tag;
}
