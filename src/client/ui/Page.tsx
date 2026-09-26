// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head of a view and its states in one place: a label over the
// title, or a crumb with the title on one line for a page whose title
// is a noun (one parent, or several steps), actions on the right, a
// notice row across the head for what a page that saves from its head
// asks or refuses, then either the content, a loading line, an empty
// line or the page's failure: what failed, the words, and Try again. A
// view composes this, never restyles it.

import { useSignal } from "@preact/signals";
import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Failure } from "../lib/format.ts";
import { sentence } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { scrollParent } from "../lib/scroll.ts";
import "./page.css";
import { CodeTag } from "./CodeTag.tsx";

// a step of a crumb, a link back when it has an address; a path's step
// is in mono and keeps its own case
export type PageStep = {
  label: string;
  href?: string;
  mono?: boolean;
  // shown on hover: a step's whole name, or what a collapsed one holds
  title?: string;
};

export function Page({
  label,
  crumb,
  crumbHref,
  steps,
  titleMono,
  titleHref,
  title,
  menu,
  actions,
  notice,
  loading,
  empty,
  error,
  flush,
  split,
  children,
}: {
  label?: string;
  // "Account / Profile" on one line, the title in the foreground; an
  // empty crumb is the one-line head with the title alone
  crumb?: string;
  // where the crumb's parent leads, when it is a page
  crumbHref?: string;
  // the crumb's steps before the title, in place of `crumb`; a phone
  // keeps the nearest and the title
  steps?: PageStep[];
  // the title is a path's step: mono, its own case
  titleMono?: boolean;
  // where the title leads, the crumb's last step then a link: a file's
  // page from any of its views, its history or a past revision
  titleHref?: string;
  title: string;
  // the title's node when the view wraps it in a control: a chat's
  // menu, opened by the title itself. The view renders the title text
  // and its heading, since what the control opens is no part of it
  menu?: ComponentChildren;
  actions?: ComponentChildren;
  // a PageNotice under the crumb and the actions, spanning the head, so
  // it stays in view with them
  notice?: ComponentChildren;
  loading?: boolean;
  empty?: string;
  // the load's failure, or a view's own words for why there is nothing
  error?: Failure | string | null;
  // the view has a foot stuck to the bottom and spends the inset there
  flush?: boolean;
  // the content is a Split: the head's row ends where its main column
  // does, so no action sits over the aside
  split?: boolean;
  children?: ComponentChildren;
}) {
  const head = useRef<HTMLDivElement>(null);
  // with a menu the row is no heading: the menu's items would read as
  // the page's title
  const Crumb = menu === undefined ? "h1" : "div";
  const failed: Failure | null =
    typeof error === "string"
      ? error === ""
        ? null
        : { words: error, status: null }
      : (error ?? null);
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
  const row = (
    <>
      {steps !== undefined ? (
        <Crumb class="page-crumb label">
          {steps.map((step, i) => {
            // every step but the nearest folds away on a phone
            const far = i < steps.length - 1 ? " page-crumb-far" : "";
            const mono = step.mono ? " page-crumb-path" : "";
            return (
              <Fragment key={`${i}:${step.label}`}>
                {step.href ? (
                  <a
                    class={`page-crumb-up${mono}${far}`}
                    href={step.href}
                    title={step.title}
                  >
                    {step.label}
                  </a>
                ) : (
                  <span class={`page-crumb-up${mono}${far}`}>{step.label}</span>
                )}
                <span class={`page-crumb-sep${far}`}>/</span>
              </Fragment>
            );
          })}
          {menu === undefined ? (
            titleHref !== undefined ? (
              <a
                class={`page-crumb-on page-crumb-link${
                  titleMono ? " page-crumb-path" : ""
                }`}
                href={titleHref}
                title={titleMono ? title : undefined}
              >
                {title}
              </a>
            ) : (
              <span
                class={`page-crumb-on${titleMono ? " page-crumb-path" : ""}`}
                title={titleMono ? title : undefined}
              >
                {title}
              </span>
            )
          ) : (
            <div class="page-crumb-on page-crumb-menu">{menu}</div>
          )}
        </Crumb>
      ) : crumb !== undefined ? (
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
      {actions && <div class="page-actions">{actions}</div>}
      {notice}
    </>
  );
  return (
    <div class={`page${flush ? " page-flush" : ""}`}>
      <div
        class={`page-head${stuck.value ? " page-head-stuck" : ""}${
          notice ? " page-head-notice" : ""
        }`}
        ref={head}
      >
        {split ? <div class="page-head-main">{row}</div> : row}
      </div>
      {failed ? (
        <div class="notice-failed page-failed" role="alert">
          <Icon name="alert" size={20} class="page-failed-icon" />
          <div class="page-failed-words">
            <p class="page-failed-title">
              This page did not load
              <CodeTag status={failed.status} />
            </p>
            <p class="page-failed-text">{sentence(failed.words)}</p>
          </div>
          {/* A full reload runs the route's load again, and the shell's
              with it, which is what a failed first answer needs. */}
          <button
            type="button"
            class="btn page-failed-retry"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <PageLoading />
      ) : empty ? (
        <p class="page-state">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

// the loading line of a page whose head is drawn while a part of its
// content loads
export function PageLoading() {
  return <p class="page-state">Loading</p>;
}

// the head's notice: words, then the buttons that answer them. `failed`
// for a refusal or an ask that loses something, read out at once
export function PageNotice({
  tone = "info",
  words,
  children,
}: {
  tone?: "info" | "failed";
  words: ComponentChildren;
  children?: ComponentChildren;
}) {
  const failed = tone === "failed";
  return (
    <div
      class={`page-notice${failed ? " page-notice-failed" : ""}`}
      role={failed ? "alert" : "status"}
    >
      <span class="page-notice-words">{words}</span>
      {children && <span class="page-notice-acts">{children}</span>}
    </div>
  );
}
