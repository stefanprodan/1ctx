// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A card of rows: a labelled head with an action or a hint, rows that
// open in place over the page's ground, and static rows. A view fills
// the rows and styles only what it puts inside them.

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import "./rows.css";

// the page's column of cards
export function Rows({ children }: { children: ComponentChildren }) {
  return <div class="rows">{children}</div>;
}

export function RowsCard({
  label,
  action,
  hint,
  children,
}: {
  label: string;
  action?: ComponentChildren;
  hint?: string;
  children?: ComponentChildren;
}) {
  return (
    <section class="rows-card">
      <div class="rows-head">
        <span class="label">{label}</span>
        {hint && <span class="rows-hint">{hint}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

// the head's New button
export function RowsAdd({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="btn btn-small rows-add"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="plus" size={14} />
      {label}
    </button>
  );
}

// the head's link to where the rows are managed
export function RowsLink({ label, href }: { label: string; href: string }) {
  return (
    <a class="btn btn-small rows-add" href={href}>
      {label}
    </a>
  );
}

// a faint line in the card: an empty list, or what the rows add up to
export function RowsNote({ children }: { children: ComponentChildren }) {
  return <p class="rows-note">{children}</p>;
}

// a row that opens: the chevron and the head are the toggle, `end`
// sits outside it, and the body indents to where the head's text starts
export function RowsOpen({
  open,
  onToggle,
  head,
  end,
  indent = "avatar",
  off,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  head: ComponentChildren;
  end?: ComponentChildren;
  indent?: "avatar" | "chevron";
  // the row's subject is switched off: the name goes faint
  off?: boolean;
  children?: ComponentChildren;
}) {
  const toggle = (line: boolean) => (
    <button
      type="button"
      class={`rows-toggle${line ? " rows-line" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon
        name="chevron"
        size={14}
        class={`rows-chevron${open ? " rows-chevron-open" : ""}`}
      />
      {head}
    </button>
  );
  return (
    <div
      class={`rows-item${open ? " rows-item-open" : ""}${
        off ? " rows-item-off" : ""
      }`}
    >
      {end === undefined ? (
        toggle(true)
      ) : (
        <div class="rows-line rows-line-end">
          {toggle(false)}
          {end}
        </div>
      )}
      {open && <div class={`rows-body rows-body-${indent}`}>{children}</div>}
    </div>
  );
}

// a row that does not open, its text lined up with an opening row's;
// `flush` puts its first child, a radio, where the chevron is
export function RowsLine({
  as = "div",
  flush,
  children,
}: {
  as?: "div" | "label";
  flush?: boolean;
  children: ComponentChildren;
}) {
  const Tag = as;
  return (
    <div class="rows-item">
      <Tag class={`rows-line${flush ? "" : " rows-line-static"}`}>
        {children}
      </Tag>
    </div>
  );
}

// a row that leads to its page: the whole line is the link, with the
// arrow at its end
export function RowsGo({
  href,
  children,
}: {
  href: string;
  children: ComponentChildren;
}) {
  return (
    <div class="rows-item">
      <a class="rows-line rows-go" href={href}>
        {children}
        <Icon name="chevron-right" size={14} class="rows-go-arrow" />
      </a>
    </div>
  );
}

// the form of a new row, open at the top of the card
export function RowsNew({ children }: { children: ComponentChildren }) {
  return (
    <div class="rows-item rows-item-open">
      <div class="rows-body rows-body-new">{children}</div>
    </div>
  );
}

export function RowsAvatar({
  lit,
  children,
}: {
  lit?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span class={`rows-avatar${lit ? " rows-avatar-lit" : ""}`}>
      {children}
    </span>
  );
}

// the name over a faint line; mono for a name that is an identifier
export function RowsTitle({
  name,
  sub,
  mono,
}: {
  name: ComponentChildren;
  sub?: ComponentChildren;
  mono?: boolean;
}) {
  return (
    <span class="rows-title">
      <span class={`rows-name${mono ? " rows-name-mono" : ""}`}>{name}</span>
      {sub !== undefined && <span class="rows-sub">{sub}</span>}
    </span>
  );
}

// the faint words at the row's right; under 720 they wrap below
export function RowsMeta({
  bad,
  children,
}: {
  bad?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span class={`rows-meta${bad ? " rows-meta-bad" : ""}`}>{children}</span>
  );
}
