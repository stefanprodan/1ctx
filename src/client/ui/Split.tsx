// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type ComponentChildren, Fragment, isValidElement } from "preact";
import "./split.css";

export function Split({
  aside,
  children,
}: {
  aside: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class="split">
      <div class="split-main">{children}</div>
      <div class="split-aside">{aside}</div>
    </div>
  );
}

export function AsideSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="split-section">
      <div class="split-section-head">
        <span class="label">{label}</span>
        {action && <span class="split-section-act">{action}</span>}
      </div>
      {children}
    </section>
  );
}

// the words of a value, for the title of one cut short
function textOf(children: ComponentChildren): string | undefined {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (isValidElement(children)) {
    return textOf(
      (children.props as { children?: ComponentChildren }).children,
    );
  }
  if (!Array.isArray(children)) return undefined;
  const parts = children.map(textOf);
  return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
}

// A label and its value, the section's labels in one column and its
// values aligned in the next. A value of words wraps in its column; a
// one-token value is cut and keeps its whole text as the title. A value
// with an href is a quiet link, a handle's or an email's.
export function AsideLine({
  label,
  cut,
  href,
  quiet,
  children,
}: {
  label: string;
  cut?: boolean;
  href?: string;
  quiet?: boolean;
  children: ComponentChildren;
}) {
  const strong = `split-strong${cut ? " cut" : ""}${quiet ? " split-quiet" : ""}${href === undefined ? "" : " split-handle"}`;
  const title = cut ? textOf(children) : undefined;
  return (
    <div class="split-line split-pair">
      <span class="split-label">{label}</span>
      {href === undefined ? (
        <span class={strong} title={title}>
          {children}
        </span>
      ) : (
        <a class={strong} href={href} title={title}>
          {children}
        </a>
      )}
    </div>
  );
}

// names in a value, comma separated, each kept whole on its line and
// cut with its title only when longer than the column
export function AsideNames({ names }: { names: readonly string[] }) {
  return names.map((name, i) => (
    <Fragment key={name}>
      {i > 0 && ", "}
      <span class="split-word" title={name}>
        {name}
      </span>
    </Fragment>
  ));
}

// a handle inside a value: a link in the value's colour, yellow only on
// hover, so the aside stays quiet beside the page's yellow handles
export function AsideHandle({ name, href }: { name: string; href: string }) {
  return (
    <a class="split-handle" href={href}>
      @{name}
    </a>
  );
}

// One thing in a list: its name, leading to its page, an optional faint
// line under it and a count or word at the right. Names are the aside's
// own text, never mono, whatever the rows use.
export function AsideItem({
  name,
  href,
  title = name,
  lead,
  sub,
  subHref,
  quiet,
  children,
}: {
  name: string;
  href?: string;
  // the whole name when the shown one is short, a path's last part
  title?: string;
  lead?: ComponentChildren;
  sub?: ComponentChildren;
  subHref?: string;
  quiet?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <div class="split-line split-item">
      {lead}
      <span class="split-item-body">
        {href === undefined ? (
          <span class="split-item-name cut" title={title}>
            {name}
          </span>
        ) : (
          <a class="split-item-name split-handle cut" href={href} title={title}>
            {name}
          </a>
        )}
        {sub !== undefined && (
          <span class="split-item-sub cut">
            {subHref === undefined ? (
              sub
            ) : (
              <a class="split-handle" href={subHref}>
                {sub}
              </a>
            )}
          </span>
        )}
      </span>
      {children !== undefined && (
        <span class={`split-item-end${quiet ? " split-quiet" : ""}`}>
          {children}
        </span>
      )}
    </div>
  );
}

// a sentence in a section rather than a label and its value
export function AsideNote({
  tone,
  children,
}: {
  tone?: "faint" | "error";
  children: ComponentChildren;
}) {
  return (
    <p class={`split-note${tone === undefined ? "" : ` split-note-${tone}`}`}>
      {children}
    </p>
  );
}

// undefined while the read runs, null when it failed
export function AsideRead<T>({
  label,
  action,
  value,
  children,
}: {
  label: string;
  action?: ComponentChildren;
  value: T | null | undefined;
  children: (value: T) => ComponentChildren;
}) {
  return (
    <AsideSection label={label} action={action}>
      {value === undefined ? (
        <p class="split-empty">Loading</p>
      ) : value === null ? (
        <p class="split-empty">Did not load.</p>
      ) : (
        children(value)
      )}
    </AsideSection>
  );
}
