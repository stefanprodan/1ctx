// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A board's page head: when its answer was read, or that a load runs
// or did not refresh, then Refresh, which waits while a load runs.

import type { Failure } from "../lib/format.ts";
import { clock } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import "./loaded.css";

export function Loaded({
  readAt,
  busy,
  error,
  onRefresh,
}: {
  // when the answer on screen was read, null before the first
  readAt: number | null;
  busy: boolean;
  error: Failure | null;
  onRefresh: () => void;
}) {
  const held = readAt !== null;
  const failed = !busy && error !== null && held;
  const status = busy
    ? held
      ? "Refreshing"
      : "Loading"
    : failed
      ? "Did not refresh"
      : held
        ? `Loaded ${clock(readAt)}`
        : "";
  return (
    <>
      <span
        class={`loaded${failed ? " loaded-failed" : ""}`}
        aria-live="polite"
      >
        {status}
        {failed && error.status !== null && (
          <span class="code-tag">HTTP {error.status}</span>
        )}
      </span>
      <button
        type="button"
        class="btn btn-small"
        disabled={busy}
        onClick={onRefresh}
      >
        <Icon
          name={busy ? "spinner" : "redo"}
          size={12}
          class={busy ? "loaded-spin" : undefined}
        />
        Refresh
      </button>
    </>
  );
}
