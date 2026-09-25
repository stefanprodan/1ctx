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
import { useId } from "preact/hooks";
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
  const id = useId();
  return (
    <section
      class="card rows-card"
      aria-label={search ? label : undefined}
      aria-labelledby={search ? undefined : id}
    >
      <div class={`rows-head${search ? " rows-head-search" : ""}`}>
        {search ?? (
          <span class="label" id={id}>
            {label}
          </span>
        )}
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
// the chevron is, or in a list where no row opens; a label row lights under the pointer as a row that
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
  // the arrow marks the line's end; a row with a button there leaves it
  // out, or it would sit between the words and the button
  const link = (line: boolean) => (
    <a class={line ? "rows-line rows-go" : "rows-go rows-go-part"} href={href}>
      {children}
      {line && <Icon name="chevron-right" size={14} class="rows-go-arrow" />}
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
  disabled,
  children,
}: {
  onClick: () => void;
  // while another action of the form runs
  disabled?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="rows-item">
      <button
        type="button"
        class="rows-line rows-button"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </div>
  );
}

// the same rows inset inside a form or an open row
export function RowsList({ children }: { children: ComponentChildren }) {
  return <div class="rows-list">{children}</div>;
}

// bare: inside a box that has its own frame, under a rule. ends: some
// lines carry a remove button, so every line keeps room for one and the
// notes share an edge
export function RowsLog({
  children,
  bare,
  ends,
}: {
  children: ComponentChildren;
  bare?: boolean;
  ends?: boolean;
}) {
  return (
    <div
      class={`rows-log${bare ? " rows-log-bare" : ""}${ends ? " rows-log-ends" : ""}`}
    >
      {children}
    </div>
  );
}

export function RowsLogGroup({ children }: { children: ComponentChildren }) {
  return <div class="rows-log-group">{children}</div>;
}

export function RowsLogLine({
  name,
  note,
  bad,
  running,
  status,
  onRemove,
}: {
  name: string;
  note: string;
  bad?: boolean;
  running?: boolean;
  status?: number | null;
  // a small X at the line's end, in a log drawn with `ends`
  onRemove?: () => void;
}) {
  return (
    <div
      class={`rows-log-line${bad ? " rows-log-bad" : ""}${onRemove ? " rows-log-line-end" : ""}`}
    >
      <span class="rows-log-name cut" title={name}>
        {name}
      </span>
      <span class={`rows-log-note${running ? " rows-log-running" : ""}`}>
        {note}
        {status != null && (
          <>
            {" "}
            <span class="code-tag">HTTP {status}</span>
          </>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          class="btn-icon rows-log-drop"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

export function RowsLogMore({
  children,
  onClick,
  disabled,
}: {
  children: ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      class="btn-text rows-log-more"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
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
  title,
  children,
}: {
  lit?: boolean;
  // what the avatar stands for, under the pointer
  title?: string;
  children: ComponentChildren;
}) {
  return (
    <span class={`avatar${lit ? " rows-avatar-lit" : ""}`} title={title}>
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
  subWide,
}: {
  name: ComponentChildren;
  sub?: ComponentChildren;
  mono?: boolean;
  bad?: boolean;
  // the sub line only from 720 up; a phone shows the name alone and the
  // open row holds the rest
  subWide?: boolean;
}) {
  return (
    <span class="rows-title">
      <span class={`rows-name${mono ? " rows-name-mono" : ""}`}>
        {/* the name is a flex row for a tag beside it, and a flex box
            never ellipsizes its own text, so plain words get a box */}
        {typeof name === "string" ? <span class="cut">{name}</span> : name}
      </span>
      {sub !== undefined && (
        <span
          class={`rows-sub${bad ? " rows-bad" : ""}${subWide ? " rows-sub-wide" : ""}`}
        >
          {sub}
        </span>
      )}
    </span>
  );
}

// a small word in a box beside the name: you
export function RowsTag({ children }: { children: ComponentChildren }) {
  return <span class="tag">{children}</span>;
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
  short,
  keep,
  children,
}: {
  bad?: boolean;
  // a meta of boxes, a meter or a strip, which cannot ellipsize: it
  // keeps its width and the title gives way instead
  keep?: boolean;
  // what a phone shows in place of the whole meta, the rest being in
  // the open row; empty hides the meta there
  short?: string;
  children: ComponentChildren;
}) {
  if (short === undefined) {
    return (
      <span
        class={`rows-meta${bad ? " rows-meta-bad" : ""}${keep ? " rows-meta-keep" : ""}`}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      class={`rows-meta${bad ? " rows-meta-bad" : ""}${
        short === "" ? " rows-meta-wide" : ""
      }`}
    >
      <span class="rows-meta-long">{children}</span>
      <span class="rows-meta-short">{short}</span>
    </span>
  );
}
