// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add member: a search over the people not in the project, opened in
// the list since the card clips a dropdown. A click or Enter adds one
// and the list stays open.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import { addProjectMember } from "../../data/admin-projects.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import type { Save } from "../../lib/save.ts";
import {
  RowsAvatar,
  RowsButton,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { candidateNote, candidates, step } from "./AdminProjects.model.ts";
import "./admin-projects.css";

export function MemberPicker({
  project,
  users,
  save,
}: {
  project: ProjectDetail;
  users: UserAccount[];
  // the project form's, so a refused add is the form's notice
  save: Save;
}) {
  const open = useSignal(false);
  const query = useSignal("");
  const highlight = useSignal(0);
  const adding = useSignal<string | null>(null);
  // another action of the form is running; an add in flight keeps the
  // list open on its "adding" line
  const disabled = save.busy && adding.value === null;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLDivElement>(null);
  // set by Escape and the close button, never by a click elsewhere,
  // which keeps the focus it moved
  const refocus = useRef(false);
  const memberIds = new Set(project.members.map((member) => member.id));
  const everyone = candidates(users, memberIds, "");
  const list = candidates(users, memberIds, query.value);
  const active = Math.min(highlight.value, Math.max(list.length - 1, 0));
  const listId = `admin-projects-pick-${project.id}`;
  const optionId = (user: UserAccount) => `${listId}-${user.id}`;

  const close = () => {
    open.value = false;
    query.value = "";
    highlight.value = 0;
  };

  useEffect(() => {
    if (!open.value) {
      if (refocus.current) opener.current?.querySelector("button")?.focus();
      refocus.current = false;
      return;
    }
    input.current?.focus();
    // a click on what is no longer on the page, the Add member that
    // opened the list, is not a click elsewhere
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (target.isConnected && !root.current?.contains(target)) close();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open.value]);

  // the highlighted line stays in sight while the arrows walk the list
  useEffect(() => {
    if (!open.value || list.length === 0) return;
    document
      .getElementById(optionId(list[active]))
      ?.scrollIntoView({ block: "nearest" });
  }, [open.value, active, list.length]);

  // the last one added leaves the list; a now empty list closes it
  useEffect(() => {
    if (open.value && everyone.length === 0) close();
  }, [everyone.length]);

  const add = async (user: UserAccount) => {
    if (disabled || adding.value !== null) return;
    adding.value = user.id;
    const added = await save.act(`add @${user.username}`, () =>
      addProjectMember(project.id, { userId: user.id }),
    );
    if (added) {
      query.value = "";
      highlight.value = 0;
    }
    adding.value = null;
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight.value = step(
        active,
        event.key === "ArrowDown" ? 1 : -1,
        list.length,
      );
    } else if (event.key === "Enter") {
      // the name's form must never see this Enter
      event.preventDefault();
      if (list.length > 0) void add(list[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      refocus.current = true;
      close();
    }
  };

  if (!open.value) {
    if (everyone.length === 0) return <RowsNote>Everyone is in.</RowsNote>;
    return (
      <div ref={opener}>
        <RowsButton
          disabled={disabled}
          onClick={() => {
            open.value = true;
          }}
        >
          <Icon name="plus" size={14} />
          Add member
        </RowsButton>
      </div>
    );
  }

  return (
    <div class="admin-projects-pick" ref={root}>
      <div class="admin-projects-pick-search">
        <Icon name="search" size={14} class="admin-projects-pick-glass" />
        <input
          ref={input}
          name="member-search"
          class="admin-projects-pick-input"
          role="combobox"
          aria-label="Search people"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            list.length > 0 ? optionId(list[active]) : undefined
          }
          autocomplete="off"
          spellcheck={false}
          placeholder="Search people"
          disabled={disabled}
          value={query.value}
          onInput={(event) => {
            query.value = (event.currentTarget as HTMLInputElement).value;
            highlight.value = 0;
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="btn-icon"
          aria-label="Close"
          onClick={() => {
            refocus.current = true;
            close();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {list.length === 0 ? (
        <RowsNote>No one matches.</RowsNote>
      ) : (
        <div class="admin-projects-pick-list" id={listId} role="listbox">
          {list.map((user, index) => (
            <div
              key={user.id}
              id={optionId(user)}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              aria-disabled={adding.value !== null}
              class={`menu-item admin-projects-pick-option${
                index === active ? " menu-item-on" : ""
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (highlight.value !== index) highlight.value = index;
              }}
              onClick={() => void add(user)}
              onKeyDown={onKeyDown}
            >
              <RowsAvatar lit={index === active}>
                {initials(user.fullName)}
              </RowsAvatar>
              <RowsTitle name={user.fullName} sub={`@${user.username}`} />
              <RowsMeta>
                {adding.value === user.id ? "adding" : candidateNote(user)}
              </RowsMeta>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
