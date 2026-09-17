// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one design of a list of things: a card of rows on a page, or an
// inset list of the same rows inside a form or an open row. A row is
// RowsOpen (opens in place), RowsGo (a link), RowsButton (an action) or
// RowsLine (neither); its head is only the parts below: RowsAvatar,
// RowsTitle, RowsMeta, and at its end RowsEnd, RowsSwitch, RowsCheck or
// a small button. A view fills the rows and styles only what an open
// row's body holds; a new list never draws a row of its own.

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import "./rows.css";

export {
  RowsCheck,
  RowsEnd,
  type RowsFilter,
  RowsFilters,
  RowsRadio,
  RowsSwitch,
} from "./RowsControls.tsx";

// the page's column of cards
export function Rows({ children }: { children: ComponentChildren }) {
  return <div class="rows">{children}</div>;
}

export function RowsCard({
  label,
  search,
  action,
  hint,
  live,
  children,
}: {
  label: string;
  // a search box in place of the label, for a list long enough to need
  // one; the label still names the card to a screen reader
  search?: ComponentChildren;
  action?: ComponentChildren;
  hint?: string;
  // the hint follows a selection in the card, so a screen reader hears
  // each change
  live?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <section class="rows-card" aria-label={search ? label : undefined}>
      <div class={`rows-head${search ? " rows-head-search" : ""}`}>
        {search ?? <span class="label">{label}</span>}
        {hint && (
          <span class="rows-hint" aria-live={live ? "polite" : undefined}>
            {hint}
          </span>
        )}
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
// `flush` starts it at the edge, for an avatar or a radio or a box where
// the chevron is; a label row lights under the pointer as a row that
// opens does, unless `off`
export function RowsLine({
  as = "div",
  flush,
  off,
  children,
}: {
  as?: "div" | "label";
  flush?: boolean;
  // the row's subject cannot be picked now: its name goes faint
  off?: boolean;
  children: ComponentChildren;
}) {
  const Tag = as;
  return (
    <div class={`rows-item${off ? " rows-item-off" : ""}`}>
      <Tag
        class={`rows-line${flush ? "" : " rows-line-static"}${
          as === "label" ? " rows-line-pick" : ""
        }`}
      >
        {children}
      </Tag>
    </div>
  );
}

// a row that leads to its page: the line is the link, with the arrow
// at its end; `end`, a button, sits outside the link after the arrow
export function RowsGo({
  href,
  end,
  children,
}: {
  href: string;
  end?: ComponentChildren;
  children: ComponentChildren;
}) {
  const link = (line: boolean) => (
    <a class={line ? "rows-line rows-go" : "rows-go rows-go-part"} href={href}>
      {children}
      <Icon name="chevron-right" size={14} class="rows-go-arrow" />
    </a>
  );
  return (
    <div class="rows-item">
      {end === undefined ? (
        link(true)
      ) : (
        <div class="rows-line rows-line-end">
          {link(false)}
          {end}
        </div>
      )}
    </div>
  );
}

// a row that acts when pressed: the whole line is the button
export function RowsButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="rows-item">
      <button type="button" class="rows-line rows-button" onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

// the same rows inset inside a form or an open row
export function RowsList({ children }: { children: ComponentChildren }) {
  return <div class="rows-list">{children}</div>;
}

// the label over an inset list, and a faint count or word at its right
export function RowsListHead({
  label,
  required,
  hint,
}: {
  label: string;
  required?: boolean;
  hint?: ComponentChildren;
}) {
  return (
    <span class="rows-list-head">
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      {hint !== undefined && <span class="rows-list-hint">{hint}</span>}
    </span>
  );
}

// a row of text, not a thing: a prompt, cut by the view
export function RowsBlock({ children }: { children: ComponentChildren }) {
  return <div class="rows-item rows-block">{children}</div>;
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

// the name over a faint line; mono for a name that is an identifier,
// `bad` when the line is a failure
export function RowsTitle({
  name,
  sub,
  mono,
  bad,
}: {
  name: ComponentChildren;
  sub?: ComponentChildren;
  mono?: boolean;
  bad?: boolean;
}) {
  return (
    <span class="rows-title">
      <span class={`rows-name${mono ? " rows-name-mono" : ""}`}>{name}</span>
      {sub !== undefined && (
        <span class={`rows-sub${bad ? " rows-bad" : ""}`}>{sub}</span>
      )}
    </span>
  );
}

// a small word in a box beside the name: you
export function RowsTag({ children }: { children: ComponentChildren }) {
  return <span class="rows-tag">{children}</span>;
}

// who a line names, in the brand colour
export function RowsHandle({ name }: { name: string }) {
  return <span class="rows-handle">@{name}</span>;
}

// the failed part of a line
export function RowsBad({ children }: { children: ComponentChildren }) {
  return <span class="rows-bad">{children}</span>;
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
