// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A page before its view's code or the signed-in user is known: the
// head's place with a bone for its title, then a card of rows. Apart
// from Page, so the first bundle carries only the bones.

import "./page.css";
import { Bone } from "./Bones.tsx";
import { RowsWaiting } from "./RowsWaiting.tsx";

export function PageWaiting({ label }: { label: string }) {
  return (
    <div class="page">
      <div class="page-head" aria-hidden="true">
        <div class="page-crumb page-waiting-crumb bones-wait">
          <Bone kind="line" at={0} width={30} />
        </div>
      </div>
      <RowsWaiting card label={label} />
    </div>
  );
}
