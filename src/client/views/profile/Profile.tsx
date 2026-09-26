// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile: who the user is on one line, then two sections down one
// column, a heading on the left and the form on the right: the name,
// the time zone and the about text, and the password. The aside holds
// the account: the email, the role and when the user joined. The
// username is shown, not edited; an admin changes it. A Save wakes when
// something changed, says Saved for a moment, and a refusal stays beside
// it until the next edit; lib/save.ts holds that.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { FavouriteAgentResponse } from "../../../shared/api/agents.ts";
import type { Profile as ProfileRow } from "../../../shared/contracts/user.ts";
import {
  favourite,
  favouriteError,
  setFavourite,
} from "../../data/favourite.ts";
import {
  changePassword,
  profile,
  profileError,
  saveProfile,
} from "../../data/profile.ts";
import { initials, longDate } from "../../lib/format.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page, PageNotice } from "../../ui/Page.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import { Select } from "../../ui/Select.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Who, WhoLine } from "../../ui/Who.tsx";
import { ZoneSelect } from "../../ui/ZoneSelect.tsx";
import { roleWords } from "../people/People.model.ts";
import {
  aboutProblem,
  detailsFieldOf,
  fullNameProblem,
  passwordFieldOf,
  passwordFieldProblem,
} from "./Profile.model.ts";
import "./profile.css";

function DetailsForm({ user }: { user: ProfileRow }) {
  const fullName = useSignal(user.fullName);
  const about = useSignal(user.about);
  const tz = useSignal(user.tz);
  const form = useRef<HTMLDivElement>(null);
  const save = useSave(
    () =>
      saveProfile({
        fullName: fullName.value.trim(),
        about: about.value,
        tz: tz.value,
      }),
    detailsFieldOf,
  );
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("fullName", fullNameProblem(fullName.value)) ??
        at("about", aboutProblem(about.value)),
    );
  };
  return (
    <SectionForm onSubmit={submit}>
      <div class="profile-fields" ref={form}>
        <label class="field">
          <span class="label">Full name</span>
          <input
            name="fullName"
            autocomplete="name"
            aria-invalid={invalid("fullName") || undefined}
            value={fullName.value}
            onInput={save.bind(fullName)}
          />
          <FieldError save={save} field="fullName" />
        </label>
        <div class="field">
          <span class="label">Time zone</span>
          <ZoneSelect
            name="tz"
            value={tz.value}
            invalid={invalid("tz")}
            onChange={(next) => {
              tz.value = next;
              save.touch();
            }}
          />
          <FieldError save={save} field="tz" />
        </div>
        <label class="field">
          <span class="label">About</span>
          <textarea
            name="about"
            rows={5}
            placeholder="Who you are and what you work on."
            aria-invalid={invalid("about") || undefined}
            value={about.value}
            onInput={(e) => {
              about.value = (e.currentTarget as HTMLTextAreaElement).value;
              save.touch();
            }}
          />
          <FieldError save={save} field="about" />
        </label>
      </div>
      <Foot
        save={save}
        dirty={
          fullName.value.trim() !== user.fullName ||
          about.value !== user.about ||
          tz.value !== user.tz
        }
        label="Save"
      />
    </SectionForm>
  );
}

// the agent new chats and tasks start on; the first choice follows the
// default, whichever agent that is when the chat starts
function AgentForm({ answer }: { answer: FavouriteAgentResponse }) {
  const picked = useSignal(answer.agentId ?? "");
  const save = useSave(() => setFavourite(picked.value || null));
  const fallback = answer.agents.find((a) => a.id === answer.defaultId);
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(null);
  };
  return (
    <SectionForm onSubmit={submit}>
      <div class="profile-fields">
        <div class="field">
          <span class="label">Favourite agent</span>
          <Select
            label="Favourite agent"
            name="agentId"
            value={picked.value}
            options={[
              {
                value: "",
                label: "The default",
                detail: fallback ? `@${fallback.name}` : undefined,
              },
              ...answer.agents.map((a) => ({
                value: a.id,
                label: `@${a.name}`,
              })),
            ]}
            onChange={(next) => {
              picked.value = next;
              save.touch();
            }}
          />
        </div>
      </div>
      <Foot
        save={save}
        dirty={picked.value !== (answer.agentId ?? "")}
        label="Save"
      />
    </SectionForm>
  );
}

function PasswordForm() {
  const current = useSignal("");
  const next = useSignal("");
  const again = useSignal("");
  const form = useRef<HTMLDivElement>(null);
  const save = useSave(async () => {
    await changePassword({ current: current.value, next: next.value });
    current.value = "";
    next.value = "";
    again.value = "";
  }, passwordFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(passwordFieldProblem(current.value, next.value, again.value));
  };
  return (
    <SectionForm onSubmit={submit}>
      <div class="profile-fields" ref={form}>
        <label class="field">
          <span class="label">Current password</span>
          <input
            name="current"
            type="password"
            autocomplete="current-password"
            aria-invalid={invalid("current") || undefined}
            value={current.value}
            onInput={save.bind(current)}
          />
          <FieldError save={save} field="current" />
        </label>
        <div class="pair">
          <label class="field">
            <span class="label">New password</span>
            <input
              name="next"
              type="password"
              autocomplete="new-password"
              aria-invalid={invalid("next") || undefined}
              value={next.value}
              onInput={save.bind(next)}
            />
            <FieldError save={save} field="next" />
          </label>
          <label class="field">
            <span class="label">New password again</span>
            <input
              name="again"
              type="password"
              autocomplete="new-password"
              aria-invalid={invalid("again") || undefined}
              value={again.value}
              onInput={save.bind(again)}
            />
            <FieldError save={save} field="again" />
          </label>
        </div>
      </div>
      <Foot
        save={save}
        dirty={current.value !== "" && next.value !== "" && again.value !== ""}
        label="Change password"
      />
    </SectionForm>
  );
}

export function Profile() {
  const user = profile.value;
  return (
    <Page
      crumb="Account"
      title="Profile"
      split
      notice={
        favouriteError.value && (
          <PageNotice tone="failed" words={favouriteError.value.words} />
        )
      }
      loading={user === null && profileError.value === null}
      error={profileError.value}
    >
      {user && (
        <Split
          aside={
            <AsideSection label="Account">
              <AsideLine label="Email" cut>
                {user.email}
              </AsideLine>
              <AsideLine label="Role">{roleWords(user.role)}</AsideLine>
              <AsideLine label="Joined">{longDate(user.createdAt)}</AsideLine>
            </AsideSection>
          }
        >
          <div class="profile">
            {user.mustChangePassword && (
              <p class="profile-notice">
                Change the password you were handed before going on.
              </p>
            )}
            <Who
              class="profile-head"
              avatar={initials(user.fullName)}
              name={user.fullName}
            >
              <WhoLine handle>@{user.username}</WhoLine>
              {/* the aside holds the email, and it is hidden this narrow */}
              <WhoLine narrow>{user.email}</WhoLine>
            </Who>
            <Section
              title="About you"
              text="What agents should know about you."
            >
              <DetailsForm user={user} />
            </Section>
            {favourite.value && favourite.value.agents.length > 0 && (
              <Section
                title="Agent"
                text="The agent new chats and tasks start on."
              >
                <AgentForm answer={favourite.value} />
              </Section>
            )}
            <Section
              title="Password"
              text="Changing it signs out every other device."
            >
              <PasswordForm />
            </Section>
          </div>
        </Split>
      )}
    </Page>
  );
}
