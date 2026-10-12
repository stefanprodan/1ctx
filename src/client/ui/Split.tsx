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
// one-token value is cut and keeps its whole text as the title.
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
  const strong = `split-strong${cut ? " cut" : ""}${quiet ? " split-quiet" : ""}`;
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
