// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
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
  return (
    <div class="split-line">
      {label}
      {href === undefined ? (
        <span class={strong}>{children}</span>
      ) : (
        <a class={strong} href={href}>
          {children}
        </a>
      )}
    </div>
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
