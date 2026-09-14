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
import { initials, reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { RowsAvatar } from "../../ui/Rows.tsx";
import { candidateNote, candidates, step } from "./AdminProjects.model.ts";
import "./admin-projects.css";

export function MemberPicker({
  project,
  users,
  disabled,
}: {
  project: ProjectDetail;
  users: UserAccount[];
  disabled: boolean;
}) {
  const open = useSignal(false);
  const query = useSignal("");
  const highlight = useSignal(0);
  const adding = useSignal<string | null>(null);
  const failure = useSignal<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
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
    failure.value = null;
  };

  useEffect(() => {
    if (!open.value) {
      if (refocus.current) opener.current?.focus();
      refocus.current = false;
      return;
    }
    input.current?.focus();
    const onClick = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) close();
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
    failure.value = null;
    try {
      await addProjectMember(project.id, { userId: user.id });
      query.value = "";
      highlight.value = 0;
    } catch (err) {
      failure.value = reason(err);
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
    return (
      <button
        ref={opener}
        type="button"
        class="admin-projects-pick-open"
        disabled={disabled || everyone.length === 0}
        onClick={(event) => {
          // the click that opens must not reach the outside listener
          event.stopPropagation();
          open.value = true;
        }}
      >
        <Icon name="plus" size={14} />
        {everyone.length === 0 ? "Everyone is in" : "Add member"}
      </button>
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
            failure.value = null;
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="admin-projects-pick-close"
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
        <p class="admin-projects-pick-none">No one matches.</p>
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
              class={`admin-projects-pick-option${
                index === active ? " admin-projects-pick-option-on" : ""
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
              <span class="admin-projects-person">
                <span class="admin-projects-person-name">{user.fullName}</span>
                <span class="admin-projects-person-user">@{user.username}</span>
              </span>
              <span class="admin-projects-pick-note">
                {adding.value === user.id ? "adding" : candidateNote(user)}
              </span>
            </div>
          ))}
        </div>
      )}
      {failure.value !== null && (
        <p class="admin-projects-pick-none error">{failure.value}</p>
      )}
    </div>
  );
}
