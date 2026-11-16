// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A page before its view's code or the signed-in user is known: the
// head's place with a bone for its title, then a card of rows, or the
// view's own body shape. Apart from Page, so the first bundle carries
// only the bones.

import type { ComponentChildren } from "preact";
import "./page.css";
import { Bone } from "./Bones.tsx";
import { RowsWaiting } from "./RowsWaiting.tsx";

export function PageWaiting({
  label,
  flush,
  children,
}: {
  label: string;
  // the view's foot is stuck to the bottom, as Page's flush says
  flush?: boolean;
  // the body's own shape, one role="status" naming what loads
  children?: ComponentChildren;
}) {
  return (
    <div class={`page${flush ? " page-flush" : ""}`}>
      <div class="page-head" aria-hidden="true">
        <div class="page-crumb page-waiting-crumb bones-wait">
          <Bone kind="line" at={0} width={30} />
        </div>
      </div>
      {children ?? <RowsWaiting card label={label} />}
    </div>
  );
}
