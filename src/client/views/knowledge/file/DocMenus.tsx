// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file page's two menus: More in the head, with what the head has
// no room for, and Outline in the band, the headings of a Markdown file
// that each scroll to their place. Either closes on a click outside it
// or on Escape.

import { useMenu } from "../../../composer/menu.ts";
import { Icon, type IconName } from "../../../lib/icons.tsx";
import { scrollParent } from "../../../lib/scroll.ts";
import { baseName, foldersOf } from "../../../lib/tree.ts";
import { newFileIn, type OutlineEntry } from "./DocPage.model.ts";
import { downloadText } from "./Download.ts";
import "./docpage.css";

export type MoreAction = {
  label: string;
  icon:
    | "clock"
    | "copy"
    | "download"
    | "arrow-right"
    | "plus"
    | "trash"
    | "upload";
  danger?: boolean;
  href?: string;
  onPick?: () => void;
};

// the head's More: the history, copies, the download, then what
// changes the file
export function fileActions(
  projectId: string,
  name: string,
  text: string,
  history: string,
  on: { rename: () => void; remove: () => void },
): MoreAction[] {
  const folder = foldersOf(name).at(-1) ?? "";
  const copy = (value: string) => () =>
    void navigator.clipboard?.writeText(value).catch(() => {});
  return [
    { label: "History", icon: "clock", href: history },
    { label: "Copy the text", icon: "copy", onPick: copy(text) },
    { label: "Copy the path", icon: "copy", onPick: copy(name) },
    {
      label: "Download",
      icon: "download",
      onPick: () => downloadText(baseName(name), text),
    },
    { label: "Rename or move", icon: "arrow-right", onPick: on.rename },
    {
      label: `New file in ${folder === "" ? "the top folder" : `${folder}/`}`,
      icon: "plus",
      href: newFileIn(projectId, folder),
    },
    { label: "Delete", icon: "trash", danger: true, onPick: on.remove },
  ];
}

// a menu under an icon button: More in a file's head, or the tab's +
export function MoreMenu({
  actions,
  label = "More",
  icon = "more",
  button = "btn-icon",
}: {
  actions: MoreAction[];
  label?: string;
  icon?: IconName;
  // the button's own classes: an icon alone, or a small button
  button?: string;
}) {
  const { open, root } = useMenu();
  return (
    <div class="docpage-more" ref={root}>
      <button
        type="button"
        class={button}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <Icon name={icon} size={button === "btn-icon" ? 14 : 12} />
      </button>
      {open.value && (
        <div class="menu docpage-menu" role="menu">
          {actions.map((action) => {
            const danger = action.danger ? " docpage-menu-danger" : "";
            const cls = `menu-item${danger}`;
            const body = (
              <>
                <Icon name={action.icon} size={14} />
                <span class="docpage-menu-words">{action.label}</span>
              </>
            );
            return action.href !== undefined ? (
              <a
                key={action.label}
                class={cls}
                role="menuitem"
                href={action.href}
                onClick={() => {
                  open.value = false;
                }}
              >
                {body}
              </a>
            ) : (
              <button
                key={action.label}
                type="button"
                class={cls}
                role="menuitem"
                onClick={() => {
                  open.value = false;
                  action.onPick?.();
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// the heading's place under the page's stuck head, and the focus on it,
// as a skip link moves it
function goToHeading(body: HTMLElement | null, index: number): void {
  // the outline leaves an empty heading out, so the count does too
  const heading = [
    ...(body?.querySelectorAll<HTMLElement>(".md-h2, .md-h3") ?? []),
  ].filter((h) => (h.textContent ?? "").trim() !== "")[index];
  if (!heading) return;
  const scroller = scrollParent(heading);
  if (!scroller) return;
  const head = document.querySelector(".page-head");
  const top = head?.getBoundingClientRect().bottom ?? 0;
  scroller.scrollTop += heading.getBoundingClientRect().top - top - 12;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

export function OutlineMenu({
  entries,
  body,
}: {
  entries: OutlineEntry[];
  // the rendered text the headings are in
  body: () => HTMLElement | null;
}) {
  const { open, root } = useMenu();
  return (
    <div class="docpage-more" ref={root}>
      <button
        type="button"
        class="btn btn-small"
        aria-haspopup="menu"
        aria-expanded={open.value}
        aria-label="Outline"
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <Icon name="list" size={12} />
        <span class="docpage-word">Outline</span>
      </button>
      {open.value && (
        <div class="menu docpage-menu docpage-outline" role="menu">
          {entries.map((entry, i) => (
            <button
              key={`${i}:${entry.text}`}
              type="button"
              class={`menu-item${entry.level === 3 ? " docpage-menu-sub" : ""}`}
              role="menuitem"
              onClick={() => {
                open.value = false;
                goToHeading(body(), i);
              }}
            >
              <span class="docpage-menu-words">{entry.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
