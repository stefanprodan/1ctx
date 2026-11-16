// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's place while what picks its project or names it loads,
// at the tall composer's size, so the feed under it never moves: Home
// draws it while the project list loads, a project's Feed tab while
// its row does.

import { Bone, waitRole } from "../../ui/Bones.tsx";
import "./home.css";

export function ComposerWaiting({
  label,
}: {
  // none for a piece of a wait whose outer body says it
  label?: string;
}) {
  return (
    <div class="card home-composer bones-wait" {...waitRole(label)}>
      <Bone kind="line" at={0} width={36} />
      <span class="home-composer-row" aria-hidden="true">
        <Bone kind="chip" at={1} class="home-composer-chip" />
        <Bone kind="chip" at={2} class="home-composer-chip" />
      </span>
    </div>
  );
}
