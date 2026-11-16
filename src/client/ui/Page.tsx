// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Failure } from "../lib/format.ts";
import { sentence } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { scrollParent } from "../lib/scroll.ts";
import { useWaited } from "../lib/slow.ts";
import { REVEAL_MS, SHOW_MS, useWaiting, waitClock } from "../lib/wait.ts";
import "./page.css";
import { Bone } from "./Bones.tsx";
import { CodeTag } from "./CodeTag.tsx";
import { Finder } from "./Finder.tsx";
import { RowsWaiting } from "./RowsWaiting.tsx";

export type PageStep = {
  // null while the name is not known yet: a bone in its place
  label: string | null;
  href?: string;
  mono?: boolean;
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
  pending,
  waiting,
  waitKey,
  empty,
  error,
  flush,
  split,
  children,
}: {
  label?: string;
  // an empty crumb is the one-line head with the title alone; null is
  // a name not known yet, drawn as a bone, never a stand-in word
  crumb?: string | null;
  crumbHref?: string;
  steps?: PageStep[];
  titleMono?: boolean;
  titleHref?: string;
  // null, as crumb's, while the name is not known yet
  title: string | null;
  // the view renders the title text and its heading, since what the
  // control opens is no part of it
  menu?: ComponentChildren;
  actions?: ComponentChildren;
  notice?: ComponentChildren;
  loading?: boolean;
  // a first load the body draws in its own bones, as a project's tab
  // does under the head it already has: only the head's words wait
  pending?: boolean;
  // the body's shape while loading holds, one role="status" with its
  // own label; three rows when none is given
  waiting?: ComponentChildren;
  // names a wait that goes on in the next page drawn, so its start, and
  // with it "Still loading", carries over (lib/slow.ts)
  waitKey?: string;
  empty?: string;
  error?: Failure | string | null;
  // the view has a foot stuck to the bottom and spends the inset there
  flush?: boolean;
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
  const stuck = useSignal(false);
  const wait = useWaiting(loading === true);
  const waited = useWaited(loading === true || pending === true, waitKey);
  const slow = waited.slow;
  const now = waitClock().now();
  const last = useRef<{ since: number; end: number | null } | null>(null);
  if (waited.since !== null) last.current = { since: waited.since, end: null };
  else if (last.current !== null && last.current.end === null) {
    last.current.end = now;
  }
  // bones drawn anew under a wait already shown (a carried one, or the
  // tab's under the tabs once they land) skip their reveal, else they
  // blink out for REVEAL_MS; kept through the holds after the end
  const held = last.current;
  const shownFor =
    held !== null && (held.end === null || now - held.end < SHOW_MS)
      ? now - held.since
      : 0;
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
  // a failed page never learns the name, so its bone goes with it
  const nameBone = failed === null ? <NameBone /> : null;
  // the title's bone names the heading, which has no other words yet
  const titleBone = failed === null ? <NameBone named /> : null;
  // an empty label is a name that never lands (knownProjectName)
  const shownSteps = steps?.filter(
    (step) => step.label !== "" && (failed === null || step.label !== null),
  );
  const row = (
    <>
      {shownSteps !== undefined ? (
        <Crumb class="page-crumb">
          {shownSteps.map((step, i) => {
            const far = i < shownSteps.length - 1 ? " page-crumb-far" : "";
            const mono = step.mono ? " page-crumb-path" : "";
            return (
              <Fragment key={`${i}:${step.label}`}>
                {step.label === null ? (
                  failed === null && <NameBone far={far} />
                ) : step.href ? (
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
            title === null ? (
              titleBone
            ) : titleHref !== undefined ? (
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
        <Crumb class="page-crumb">
          {crumb !== "" && (crumb !== null || failed === null) && (
            <>
              {crumb === null ? (
                nameBone
              ) : crumbHref ? (
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
            title === null ? (
              titleBone
            ) : (
              <span class="page-crumb-on">{title}</span>
            )
          ) : (
            <div class="page-crumb-on page-crumb-menu">{menu}</div>
          )}
        </Crumb>
      ) : (
        <div class="page-heading">
          {label && <span class="label">{label}</span>}
          <h1 class="page-title">{title ?? titleBone}</h1>
        </div>
      )}
      {actions && <div class="page-actions">{actions}</div>}
      {notice}
    </>
  );
  return (
    <div
      class={`page${flush ? " page-flush" : ""}${
        shownFor >= REVEAL_MS ? " bones-waited" : ""
      }`}
      style={
        shownFor >= REVEAL_MS ? { "--waited": `${shownFor}ms` } : undefined
      }
    >
      <div
        class={`page-head${stuck.value ? " page-head-stuck" : ""}${
          notice ? " page-head-notice" : ""
        }`}
        ref={head}
      >
        {split ? <div class="page-head-main">{row}</div> : row}
        {/* a live region mounted from the start, so a reader hears the
            words that fill it, and no second status beside the body's */}
        <p
          class={`page-slow${slow ? "" : " page-slow-quiet"}`}
          aria-live="polite"
        >
          {slow ? "Still loading" : ""}
        </p>
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
          {/* a full reload runs the shell's load again too */}
          <button
            type="button"
            class="btn page-failed-retry"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      ) : wait ? (
        (waiting ?? (
          <RowsWaiting
            card
            label={title === null ? "Loading the page" : `Loading ${title}`}
          />
        ))
      ) : empty ? (
        <p class="page-state">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

// a name the head shows once it is known, at a short name's width; a
// far step's bone goes where its name would on a phone
function NameBone({ far = "", named }: { far?: string; named?: boolean }) {
  return (
    <span class={`page-crumb-bone bones-wait${far}`}>
      <Bone kind="line" at={0} width={100} />
      {named && <span class="page-hidden">Loading</span>}
    </span>
  );
}

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

export function PageNew({ href, label }: { href: string; label: string }) {
  return (
    <a class="btn btn-small" href={href}>
      <Icon name="plus" size={14} />
      {label}
    </a>
  );
}

// the caller orders the items
export function PageSwitcher({
  label,
  current,
  name,
  items,
  mono = true,
  placeholder,
  none,
}: {
  label: string;
  current: string;
  name: string;
  items: { id: string; label: string; href: string }[];
  mono?: boolean;
  placeholder: string;
  none: string;
}) {
  if (items.length < 2) {
    return (
      <span class={`page-crumb-on${mono ? " page-crumb-path" : ""}`}>
        {name}
      </span>
    );
  }
  return (
    <Finder
      label={label}
      triggerClass="page-pill"
      title={name}
      trigger={
        <>
          <span class="cut">{name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={items.map((i) => ({
        value: i.id,
        label: i.label,
        href: i.href,
      }))}
      value={current}
      mono={mono}
      wide
      placeholder={placeholder}
      none={none}
    />
  );
}
