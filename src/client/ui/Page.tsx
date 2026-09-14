// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head of a view and its states in one place: a label over the
// title, or a crumb with the title on one line for a page whose title
// is a noun, actions on the right, then either the content, a loading
// line, an empty line or an error. A view composes this, never
// restyles it.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { scrollParent } from "../lib/scroll.ts";
import "./page.css";

export function Page({
  label,
  crumb,
  crumbHref,
  title,
  menu,
  aside,
  actions,
  loading,
  empty,
  error,
  flush,
  children,
}: {
  label?: string;
  // "Account / Profile" on one line, the title in the foreground; an
  // empty crumb is the one-line head with the title alone
  crumb?: string;
  // where the crumb's parent leads, when it is a page
  crumbHref?: string;
  title: string;
  // the title's node when the view wraps it in a control: a chat's
  // menu, opened by the title itself. The view renders the title text
  // and its heading, since what the control opens is no part of it
  menu?: ComponentChildren;
  aside?: ComponentChildren;
  actions?: ComponentChildren;
  loading?: boolean;
  empty?: string;
  error?: string | null;
  // the view has a foot stuck to the bottom and spends the inset there
  flush?: boolean;
  children?: ComponentChildren;
}) {
  const head = useRef<HTMLDivElement>(null);
  // with a menu the row is no heading: the menu's items would read as
  // the page's title
  const Crumb = menu === undefined ? "h1" : "div";
  // content has scrolled under the head: it casts its shadow
  const stuck = useSignal(false);
  useEffect(() => {
    const el = head.current;
    const scroller = el ? scrollParent(el) : null;
    if (!scroller) return;
    const onScroll = () => {
      stuck.value = scroller.scrollTop > 0;
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [stuck]);
  return (
    <div class={`page${flush ? " page-flush" : ""}`}>
      <div
        class={`page-head${stuck.value ? " page-head-stuck" : ""}`}
        ref={head}
      >
        {crumb !== undefined ? (
          <Crumb class="page-crumb label">
            {crumb !== "" && (
              <>
                {crumbHref ? (
                  <a class="page-crumb-up" href={crumbHref}>
                    {crumb}
                  </a>
                ) : (
                  <span>{crumb}</span>
                )}
                <span class="page-crumb-sep">/</span>
              </>
            )}
            {menu === undefined ? (
              <span class="page-crumb-on">{title}</span>
            ) : (
              <div class="page-crumb-on page-crumb-menu">{menu}</div>
            )}
          </Crumb>
        ) : (
          <div class="page-heading">
            {label && <span class="label">{label}</span>}
            <h1 class="page-title">{title}</h1>
          </div>
        )}
        {aside && <div class="page-aside">{aside}</div>}
        {actions && <div class="page-actions">{actions}</div>}
      </div>
      {error ? (
        <p class="page-state error">{error}</p>
      ) : loading ? (
        <p class="page-state">Loading</p>
      ) : empty ? (
        <p class="page-state">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}
