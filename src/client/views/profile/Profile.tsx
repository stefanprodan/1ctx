// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile: who the user is on one line, then two sections down one
// column, a heading on the left and the form on the right: the name
// with the about text, and the password. The username is shown, not
// edited; an admin changes it. A Save wakes when something changed,
// says Saved for a moment, and a refusal stays beside it until the
// next edit; lib/save.ts holds that.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { Profile as ProfileRow } from "../../../shared/contracts/user.ts";
import {
  changePassword,
  profile,
  profileError,
  saveProfile,
} from "../../data/profile.ts";
import { initials, longDate } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  aboutProblem,
  fullNameProblem,
  passwordProblem,
} from "./Profile.model.ts";
import "./profile.css";

// a heading and a line on the left, the form on the right
function Section({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: ComponentChildren;
}) {
  return (
    <section class="profile-section">
      <div class="profile-section-head">
        <h2 class="profile-section-title">{title}</h2>
        <p class="profile-section-text">{text}</p>
      </div>
      {children}
    </section>
  );
}

function DetailsForm({ user }: { user: ProfileRow }) {
  const fullName = useSignal(user.fullName);
  const about = useSignal(user.about);
  const save = useSave(() =>
    saveProfile({ fullName: fullName.value.trim(), about: about.value }),
  );
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(fullNameProblem(fullName.value) ?? aboutProblem(about.value));
  };
  return (
    <form class="profile-form" onSubmit={submit}>
      <label class="field">
        <span class="label">Full name</span>
        <input
          name="fullName"
          autocomplete="name"
          value={fullName.value}
          onInput={(e) => {
            fullName.value = (e.currentTarget as HTMLInputElement).value;
            save.touch();
          }}
        />
      </label>
      <label class="field">
        <span class="label">About</span>
        <textarea
          name="about"
          rows={5}
          placeholder="Who you are and what you work on."
          value={about.value}
          onInput={(e) => {
            about.value = (e.currentTarget as HTMLTextAreaElement).value;
            save.touch();
          }}
        />
      </label>
      <Foot
        status={save.status.value}
        dirty={
          fullName.value.trim() !== user.fullName || about.value !== user.about
        }
        label="Save"
      />
    </form>
  );
}

function PasswordForm() {
  const current = useSignal("");
  const next = useSignal("");
  const again = useSignal("");
  const save = useSave(async () => {
    await changePassword({ current: current.value, next: next.value });
    current.value = "";
    next.value = "";
    again.value = "";
  });
  const bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    save.touch();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(passwordProblem(current.value, next.value, again.value));
  };
  return (
    <form class="profile-form" onSubmit={submit}>
      <label class="field">
        <span class="label">Current password</span>
        <input
          name="current"
          type="password"
          autocomplete="current-password"
          value={current.value}
          onInput={bind(current)}
        />
      </label>
      <div class="profile-pair">
        <label class="field">
          <span class="label">New password</span>
          <input
            name="next"
            type="password"
            autocomplete="new-password"
            value={next.value}
            onInput={bind(next)}
          />
        </label>
        <label class="field">
          <span class="label">New password again</span>
          <input
            name="again"
            type="password"
            autocomplete="new-password"
            value={again.value}
            onInput={bind(again)}
          />
        </label>
      </div>
      <Foot
        status={save.status.value}
        dirty={current.value !== "" && next.value !== "" && again.value !== ""}
        label="Change password"
      />
    </form>
  );
}

export function Profile() {
  const user = profile.value;
  return (
    <Page
      crumb="Account"
      title="Profile"
      loading={user === null && profileError.value === null}
      error={profileError.value}
    >
      {user && (
        <div class="profile">
          <div class="profile-head">
            <span class="profile-avatar">{initials(user.fullName)}</span>
            <div class="profile-who">
              <span class="profile-name">{user.fullName}</span>
              <span class="profile-meta">@{user.username}</span>
              <span class="profile-meta">
                joined {longDate(user.createdAt)}
              </span>
            </div>
          </div>
          <Section title="About you" text="What agents should know about you.">
            <DetailsForm user={user} />
          </Section>
          <Section
            title="Password"
            text="Changing it signs out every other device."
          >
            <PasswordForm />
          </Section>
        </div>
      )}
    </Page>
  );
}
