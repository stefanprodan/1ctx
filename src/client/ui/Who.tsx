// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who a page is about, on one line: the big avatar, then the name over
// faint lines. The profile, a user's page and an agent's page open with
// it. A line marked narrow shows only where the aside is hidden, for
// what the aside would say.

import type { ComponentChildren } from "preact";
import "./who.css";

export function Who({
  avatar,
  agent,
  name,
  mono,
  tag,
  class: extra,
  children,
}: {
  avatar: ComponentChildren;
  // the avatar in the brand colour, as the transcript draws an agent
  agent?: boolean;
  name: ComponentChildren;
  // the name is an identifier
  mono?: boolean;
  // a small framed word after the name, which gives way first
  tag?: string;
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class={`who${extra ? ` ${extra}` : ""}`}>
      <span class={`avatar avatar-56${agent ? " avatar-agent" : ""}`}>
        {avatar}
      </span>
      <div class="who-text">
        <span class={`who-name${mono ? " who-name-mono" : ""}`}>
          <span class="cut">{name}</span>
          {tag && <span class="tag">{tag}</span>}
        </span>
        {children}
      </div>
    </div>
  );
}

// a faint line under the name; the handle in the brand colour
export function WhoLine({
  handle,
  narrow,
  children,
}: {
  handle?: boolean;
  narrow?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span
      class={`who-line${handle ? " who-handle" : ""}${
        narrow ? " who-narrow" : ""
      }`}
    >
      {children}
    </span>
  );
}
