// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings card, as Vercel's settings: a title, one line, the control,
// and a foot with its hint and its own Save, so each card saves apart.
// A card of what an object carries is `list`: the title, a count and
// its Add in a band over rows that run edge to edge. `danger` is the
// Delete card, last on its page, in the failed colour. A view composes
// this, never restyles it.

import type { ComponentChildren } from "preact";
import "./setting.css";

export function Setting({
  label,
  title,
  count,
  line,
  action,
  danger,
  list,
  foot,
  children,
}: {
  // names the card aloud when it has no title
  label?: string;
  title?: string;
  // faint after the title: "3 of 20"
  count?: string;
  line?: ComponentChildren;
  // at the head's right: an Add, a Change
  action?: ComponentChildren;
  danger?: boolean;
  list?: boolean;
  foot?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const head = (title !== undefined || action !== undefined) && (
    <div class={`setting-head${line === undefined ? " setting-head-one" : ""}`}>
      <div class="setting-words">
        {title !== undefined && (
          <h2 class="setting-title">
            {title}
            {count !== undefined && <span class="setting-count">{count}</span>}
          </h2>
        )}
        {line !== undefined && <p class="setting-line">{line}</p>}
      </div>
      {action}
    </div>
  );
  return (
    <section
      class={`card setting${danger ? " setting-danger" : ""}${
        list ? " setting-list" : ""
      }`}
      aria-label={title === undefined ? label : undefined}
    >
      {list ? (
        <>
          {head}
          {children}
        </>
      ) : (
        <div class="setting-body">
          {head}
          {children}
        </div>
      )}
      {foot !== undefined && <div class="setting-foot">{foot}</div>}
    </section>
  );
}

// the words at the foot's left: what a save does, or that a draft waits
export function SettingHint({ children }: { children: ComponentChildren }) {
  return <span class="setting-hint">{children}</span>;
}
