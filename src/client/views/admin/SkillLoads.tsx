// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SkillCounts } from "../../../shared/api/skills.ts";
import { count } from "../../lib/format.ts";
import { AsideLine } from "../../ui/Split.tsx";

export function LoadLines({ counts }: { counts: SkillCounts }) {
  return (
    <>
      <AsideLine label="Loads">{count(counts.loads)}</AsideLine>
      <AsideLine label="File reads">{count(counts.reads)}</AsideLine>
      <AsideLine label="Failed">{count(counts.failed)}</AsideLine>
    </>
  );
}
