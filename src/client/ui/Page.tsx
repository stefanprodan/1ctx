// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Failure } from "../lib/format.ts";
import { sentence } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { scrollParent } from "../lib/scroll.ts";
import "./page.css";
import { CodeTag } from "./CodeTag.tsx";
import { Finder } from "./Finder.tsx";

export type PageStep = {
  label: string;
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
  empty,
  error,
  flush,
  split,
  children,
}: {
  label?: string;
  // an empty crumb is the one-line head with the title alone
  crumb?: string;
  crumbHref?: string;
  steps?: PageStep[];
  titleMono?: boolean;
  titleHref?: string;
  title: string;
  // the view renders the title text and its heading, since what the
  // control opens is no part of it
  menu?: ComponentChildren;
  actions?: ComponentChildren;
  notice?: ComponentChildren;
  loading?: boolean;
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
        <Crumb class="page-crumb">
          {steps.map((step, i) => {
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
        <Crumb class="page-crumb">
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
          {/* a full reload runs the shell's load again too */}
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

export function PageLoading() {
  return <p class="page-state">Loading</p>;
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
