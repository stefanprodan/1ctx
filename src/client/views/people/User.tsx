// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page, open to every signed-in user: who they are and what
// they say about themselves, then the team projects the viewer shares
// with them. The aside is how to reach them and when it is for them;
// where it is hidden, the head carries the email and the local time.

import type { Params } from "../../app/params.ts";
import { person, personError } from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { initials, longDate } from "../../lib/format.ts";
import { Icon, projectIcon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Who, WhoLine } from "../../ui/Who.tsx";
import { peopleLine } from "../projects/Project.model.ts";
import { localTime, roleWords } from "./People.model.ts";
import "./people.css";

export function User({ params }: { params: Params }) {
  const username = params.username ?? "";
  const answer = person.value;
  const shown =
    answer !== null && answer.user.username === username ? answer : null;
  // the local time moves on the minute
  const now = useNow(60_000);
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
              <AsideLine label="Email" cut href={`mailto:${shown.user.email}`}>
                {shown.user.email}
              </AsideLine>
              <AsideLine label="Role">{roleWords(shown.user.role)}</AsideLine>
              <AsideLine label="Local time">
                {localTime(shown.user.tz, now)}
              </AsideLine>
              <AsideLine label="Zone" cut>
                {shown.user.tz}
              </AsideLine>
              <AsideLine label="Joined">
                {longDate(shown.user.createdAt)}
              </AsideLine>
            </AsideSection>
          }
        >
          <div class="people">
            <Who
              avatar={initials(shown.user.fullName)}
              name={shown.user.fullName}
              tag={shown.user.disabled ? "Disabled" : undefined}
            >
              <WhoLine handle>@{shown.user.username}</WhoLine>
              {/* the aside holds these, and it is hidden this narrow */}
              <WhoLine narrow>{shown.user.email}</WhoLine>
              <WhoLine narrow>
                {localTime(shown.user.tz, now)} in {shown.user.tz}
              </WhoLine>
            </Who>
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
