// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page, open to every signed-in user: who they are, their
// actions per day in every project, then tabs at their own addresses:
// what they say about themselves, and the team projects the viewer
// shares with them. The aside is how to reach them and when it is for
// them; where it is hidden, the head carries the email and the local
// time.

import { useMemo } from "preact/hooks";
import type { DirectoryUserResponse } from "../../../shared/api/directory.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import {
  person,
  personDays,
  personDaysFailed,
  personError,
} from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { initials, longDate } from "../../lib/format.ts";
import { Icon, projectIcon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsBlock,
  RowsCard,
  RowsGo,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { Who, WhoLine } from "../../ui/Who.tsx";
import { ACTION_WORDS, activityModel } from "../projects/Activity.model.ts";
import { Activity, ActivityGhost } from "../projects/Activity.tsx";
import { peopleLine } from "../projects/Project.model.ts";
import {
  localTime,
  personAnswer,
  roleWords,
  userTab,
  userTabs,
} from "./People.model.ts";
import "./people.css";

// the person's actions per day, the Projects page's card in their
// words; its ghost while they load, nothing when their first load
// failed
function UserActivity({
  username,
  userId,
}: {
  username: string;
  userId: string;
}) {
  const held = personDays.value;
  const body = held !== null && held.username === username ? held.body : null;
  const answer = useMemo(
    () => (body === null ? null : personAnswer(body, userId)),
    [body, userId],
  );
  const model = useMemo(
    () => (answer === null ? null : activityModel(answer)),
    [answer],
  );
  if (answer !== null && model !== null) {
    return (
      <Rows>
        <Activity answer={answer} model={model} words={ACTION_WORDS} />
      </Rows>
    );
  }
  // no empty wrapper when the days failed, so the head keeps one gap
  return personDaysFailed.value ? null : (
    <Rows>
      <ActivityGhost />
    </Rows>
  );
}

// the text they wrote, then the time where they are, so a reader can
// tell whether they are likely at work now
function AboutTab({
  about,
  tz,
  now,
}: {
  about: string;
  tz: string;
  now: number;
}) {
  const time = localTime(tz, now);
  return (
    <Rows>
      <RowsCard label="About">
        {about === "" ? (
          <RowsNote>Nothing written yet.</RowsNote>
        ) : (
          <RowsBlock>
            <p class="people-about">{about}</p>
          </RowsBlock>
        )}
        {time !== "" && (
          <RowsBlock>
            <p class="people-foot">
              <Icon name="clock" size={14} />
              Local time {time}
            </p>
          </RowsBlock>
        )}
      </RowsCard>
    </Rows>
  );
}

function ProjectsTab({
  shown,
  self,
}: {
  shown: DirectoryUserResponse;
  self: boolean;
}) {
  return (
    <Rows>
      <RowsCard label={self ? "Your team projects" : "Projects in common"}>
        {shown.projects.length === 0 && (
          <RowsNote>
            {self ? "No team projects yet." : "No team projects in common."}
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
  );
}

export function User({ params }: { params: Params }) {
  const username = params.username ?? "";
  const answer = person.value;
  const shown =
    answer !== null && answer.user.username === username ? answer : null;
  // the local time moves on the minute
  const now = useNow(60_000);
  const self = me.value?.id === shown?.user.id;
  const tab = userTab(path.value, username);
  const tabs = shown === null ? [] : userTabs(username, shown);
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
            <UserActivity username={username} userId={shown.user.id} />
            <div class="people-tabs">
              <Tabs tabs={tabs} active={tabs[tab].href} />
              {tab === 0 && (
                <AboutTab
                  about={shown.user.about}
                  tz={shown.user.tz}
                  now={now}
                />
              )}
              {tab === 1 && <ProjectsTab shown={shown} self={self} />}
            </div>
          </div>
        </Split>
      )}
    </Page>
  );
}
