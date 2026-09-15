// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page, open to every signed-in user: who they are and what
// they say about themselves, then the team projects the viewer shares
// with them. The aside is how to reach them and when it is for them;
// where it is hidden, the head carries the email and the local time.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { person, personError } from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { initials, longDate } from "../../lib/format.ts";
import { Icon, projectIcon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { peopleLine } from "../projects/Project.model.ts";
import { localTime } from "./People.model.ts";
import "./people.css";

// the local time moves on the minute
const MINUTE = 60 * 1000;

export function User({ params }: { params: Params }) {
  const username = params.username ?? "";
  const answer = person.value;
  const shown =
    answer !== null && answer.user.username === username ? answer : null;
  const now = useSignal(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, MINUTE);
    return () => clearInterval(timer);
  }, [now]);
  const self = me.value?.id === shown?.user.id;
  return (
    <Page
      crumb="People"
      title={`@${username}`}
      loading={shown === null && personError.value === null}
      error={personError.value}
    >
      {shown && (
        <Split
          aside={
            <AsideSection label="Account">
              <div class="split-line">
                Email
                <a
                  class="split-strong people-cut"
                  href={`mailto:${shown.user.email}`}
                >
                  {shown.user.email}
                </a>
              </div>
              <div class="split-line">
                Role
                <span class="split-strong">
                  {shown.user.role === "admin" ? "Admin" : "Member"}
                </span>
              </div>
              <div class="split-line">
                Local time
                <span class="split-strong">
                  {localTime(shown.user.tz, now.value)}
                </span>
              </div>
              <div class="split-line">
                Zone
                <span class="split-strong people-cut">{shown.user.tz}</span>
              </div>
              <div class="split-line">
                Joined
                <span class="split-strong">
                  {longDate(shown.user.createdAt)}
                </span>
              </div>
            </AsideSection>
          }
        >
          <div class="people">
            <div class="people-head">
              <span class="people-avatar">{initials(shown.user.fullName)}</span>
              <div class="people-who">
                <span class="people-name">
                  <span class="people-cut">{shown.user.fullName}</span>
                  {shown.user.disabled && (
                    <span class="people-tag">Disabled</span>
                  )}
                </span>
                <span class="people-meta people-handle">
                  @{shown.user.username}
                </span>
                {/* the aside holds these, and it is hidden this narrow */}
                <span class="people-meta people-narrow">
                  {shown.user.email}
                </span>
                <span class="people-meta people-narrow">
                  {localTime(shown.user.tz, now.value)} in {shown.user.tz}
                </span>
              </div>
            </div>
            <section class="people-section">
              <span class="label">About</span>
              {shown.user.about === "" ? (
                <p class="people-empty">Nothing written yet.</p>
              ) : (
                <p class="people-about">{shown.user.about}</p>
              )}
            </section>
            <Rows>
              <RowsCard
                label={self ? "Your team projects" : "Projects in common"}
              >
                {shown.projects.length === 0 && (
                  <RowsNote>
                    {self
                      ? "No team projects yet."
                      : "No team projects in common."}
                  </RowsNote>
                )}
                {shown.projects.map((p) => (
                  <RowsGo key={p.id} href={`/projects/${p.id}`}>
                    <RowsAvatar>
                      <Icon name={projectIcon(p.kind)} size={14} />
                    </RowsAvatar>
                    <RowsTitle name={p.name} sub={peopleLine(p)} mono />
                  </RowsGo>
                ))}
              </RowsCard>
            </Rows>
          </div>
        </Split>
      )}
    </Page>
  );
}
