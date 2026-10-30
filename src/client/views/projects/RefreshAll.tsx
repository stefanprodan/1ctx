// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { RepoView } from "../../../shared/api/repos.ts";
import { ApiError } from "../../data/api.ts";
import { type RepoTarget, refreshRepo } from "../../data/repos.ts";
import { type Failure, failure } from "../../lib/format.ts";

// marks every settled row for a fetch: a row already waiting or fetching
// is left alone, since a refresh drops its lookup and asks the host again.
// A row another tab deleted is no failure; the list reads again.
export async function refreshAll(
  target: RepoTarget,
  list: readonly RepoView[],
): Promise<Failure | null> {
  const results = await Promise.allSettled(
    list
      .filter((r) => r.state === "ready" || r.state === "failed")
      .map((r) => refreshRepo(target, r.id)),
  );
  for (const r of results) {
    if (r.status === "fulfilled") continue;
    if (r.reason instanceof ApiError && r.reason.status === 404) continue;
    return failure(r.reason);
  }
  return null;
}

export function RefreshAll({
  target,
  list,
}: {
  target: RepoTarget;
  list: RepoView[];
}) {
  const busy = useSignal(false);
  const failed = useSignal<Failure | null>(null);
  const run = async () => {
    busy.value = true;
    failed.value = null;
    failed.value = await refreshAll(target, list);
    busy.value = false;
  };
  return (
    <>
      {failed.value !== null && (
        <span class="field-error" role="alert">
          Refresh failed: {failed.value.words}
        </span>
      )}
      <button
        type="button"
        class="btn btn-small"
        disabled={busy.value || list.length === 0}
        onClick={() => {
          void run();
        }}
      >
        Refresh all
      </button>
    </>
  );
}
