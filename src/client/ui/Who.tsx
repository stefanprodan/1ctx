// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who a page is about, on one line: the big avatar, then the name over
// faint lines. The profile, a user's page and an agent's page open with
// it. A line marked narrow shows only where the aside is hidden, for
// what the aside would say.

import type { ComponentChildren } from "preact";
import { Bone } from "./Bones.tsx";
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

// the narrow lines' widths, varied so they read as words
const NARROW_WIDTHS = [24, 34];

// the head while the page loads: the avatar, the name and its lines in
// bones; with a label it is a wait of its own, else part of its
// caller's
export function WhoWaiting({
  label,
  narrow,
  class: extra,
}: {
  // what is loading, for a screen reader: "Loading the user"
  label?: string;
  // the lines the head shows only where the aside is hidden
  narrow?: number;
  class?: string;
}) {
  const bones = (
    <>
      <Bone kind="avatar" at={0} class="who-waiting-avatar" />
      <div class="who-text who-waiting-text" aria-hidden="true">
        <span class="who-name bones-lines-line">
          <Bone kind="line" at={1} width={30} />
        </span>
        <span class="who-line bones-lines-line">
          <Bone kind="line" at={2} width={16} />
        </span>
        {Array.from({ length: narrow ?? 0 }, (_, i) => (
          <span key={i} class="who-line who-narrow bones-lines-line">
            <Bone kind="line" at={3 + i} width={NARROW_WIDTHS[i % 2]} />
          </span>
        ))}
      </div>
    </>
  );
  const owner = `who${extra ? ` ${extra}` : ""}`;
  if (label === undefined) return <div class={owner}>{bones}</div>;
  return (
    <div class={`${owner} bones-wait`} role="status" aria-label={label}>
      {bones}
    </div>
  );
}
