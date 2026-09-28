// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { type Failure, sentence } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { CodeTag } from "./CodeTag.tsx";
import "./rows.css";

export {
  RowsCheck,
  RowsEnd,
  RowsFilters,
  RowsRadio,
  RowsRemove,
  RowsSwitch,
} from "./RowsControls.tsx";
export { RowsOpen } from "./RowsOpen.tsx";
export { RowsTree, type RowsTreeNode } from "./RowsTree.tsx";

export function Rows({ children }: { children: ComponentChildren }) {
  return <div class="rows">{children}</div>;
}

export function RowsCard({
  label,
  search,
  tabs,
  action,
  hint,
  live,
  count,
  wrap,
  hintBelow,
  class: extra,
  children,
}: {
  label: string;
  search?: ComponentChildren;
  tabs?: ComponentChildren;
  action?: ComponentChildren;
  hint?: string;
  live?: boolean;
  count?: string;
  wrap?: boolean;
  // on a phone the hint takes its own line under the label, held even
  // while empty, so a hint that follows the pointer never moves the card
  hintBelow?: boolean;
  class?: string;
  children?: ComponentChildren;
}) {
  const id = useId();
  const slot = search ?? tabs;
  return (
    <section
      class={`card rows-card${extra ? ` ${extra}` : ""}`}
      aria-label={slot ? label : undefined}
      aria-labelledby={slot ? undefined : id}
    >
      <div
        class={`rows-head${search ? " rows-head-search" : ""}${
          tabs ? " rows-head-tabs" : ""
        }${wrap ? " rows-head-wrap" : ""}${hintBelow ? " rows-head-below" : ""}`}
      >
        {wrap && slot ? (
          <div class="rows-head-slot">{slot}</div>
        ) : (
          (slot ?? (
            <span class="label" id={id}>
              {label}
            </span>
          ))
        )}
        {(hint || hintBelow) && (
          <span class="rows-hint cut" aria-live={live ? "polite" : undefined}>
            {hint}
          </span>
        )}
        {count !== undefined && (
          <span class="rows-count" aria-live="polite">
            {count}
          </span>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

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

export function RowsLink({ label, href }: { label: string; href: string }) {
  return (
    <a class="btn btn-small rows-add" href={href}>
      {label}
    </a>
  );
}

export function RowsNote({ children }: { children: ComponentChildren }) {
  return <p class="rows-note">{children}</p>;
}

export function RowsLine({
  as = "div",
  flush,
  off,
  children,
}: {
  as?: "div" | "label";
  flush?: boolean;
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

export function RowsGo({
  href,
  end,
  under,
  off,
  children,
}: {
  href: string;
  end?: ComponentChildren;
  under?: ComponentChildren;
  off?: boolean;
  children: ComponentChildren;
}) {
  // a row with a button at its end leaves the arrow out, or it would
  // sit between the words and the button
  const link = (line: boolean) => (
    <a class={line ? "rows-line rows-go" : "rows-go rows-go-part"} href={href}>
      {children}
      {line && <Icon name="chevron-right" size={14} class="rows-go-arrow" />}
    </a>
  );
  return (
    <div class={`rows-item${off ? " rows-item-off" : ""}`}>
      {end === undefined ? (
        link(true)
      ) : (
        <div class="rows-line rows-line-end">
          {link(false)}
          {end}
        </div>
      )}
      {under}
    </div>
  );
}

export function RowsButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
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

export function RowsList({ children }: { children: ComponentChildren }) {
  return <div class="rows-list">{children}</div>;
}

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
        <CodeTag status={status} spaced />
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
}: {
  children: ComponentChildren;
  onClick: () => void;
}) {
  return (
    <button type="button" class="btn-text rows-log-more" onClick={onClick}>
      {children}
    </button>
  );
}

export function RowsListHead({
  label,
  hint,
}: {
  label: string;
  hint?: ComponentChildren;
}) {
  return (
    <span class="rows-list-head">
      <span class="label">{label}</span>
      {hint !== undefined && <span class="rows-list-hint">{hint}</span>}
    </span>
  );
}

export function RowsBlock({ children }: { children: ComponentChildren }) {
  return <div class="rows-item rows-block">{children}</div>;
}

export function RowsFailed({ failure }: { failure: Failure }) {
  return (
    <RowsBlock>
      <p class="notice-failed" role="alert">
        {sentence(failure.words)}
        <CodeTag status={failure.status} spaced />
      </p>
    </RowsBlock>
  );
}

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
  title?: string;
  children: ComponentChildren;
}) {
  return (
    <span class={`avatar${lit ? " rows-avatar-lit" : ""}`} title={title}>
      {children}
    </span>
  );
}

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

export function RowsTag({ children }: { children: ComponentChildren }) {
  return <span class="tag">{children}</span>;
}

export function RowsHandle({ name, gone }: { name: string; gone?: boolean }) {
  return <span class={gone ? "rows-handle-gone" : "rows-handle"}>@{name}</span>;
}

export function RowsBad({ children }: { children: ComponentChildren }) {
  return <span class="rows-bad">{children}</span>;
}

export function RowsMeta({
  bad,
  brand,
  short,
  keep,
  under,
  children,
}: {
  bad?: boolean;
  brand?: boolean;
  // a meta that cannot ellipsize (boxes, a meter): the title gives way
  keep?: boolean;
  // a phone's meta; empty hides it there
  short?: string;
  under?: ComponentChildren;
  children: ComponentChildren;
}) {
  const cls = `rows-meta${bad ? " rows-meta-bad" : ""}${
    brand ? " rows-meta-brand" : ""
  }${keep ? " rows-meta-keep" : ""}${short === "" ? " rows-meta-wide" : ""}`;
  return (
    <span class={cls}>
      {under !== undefined ? (
        <span class="rows-meta-two">
          <span>{children}</span>
          <span class="rows-meta-under">{under}</span>
        </span>
      ) : short === undefined ? (
        children
      ) : (
        <>
          <span class="rows-meta-long">{children}</span>
          <span class="rows-meta-short">{short}</span>
        </>
      )}
    </span>
  );
}
