// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access's board: who signed in over the last 30 days, then the
// accounts and the team projects that need an admin, a card per group
// and only when it holds any, each row opening its page. What runs and
// what it costs are Monitor's. The aside counts the users and the
// projects.

import { useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import type { AccessBoardResponse } from "../../../shared/api/access.ts";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { accessBoard, accessBoardError } from "../../data/access-board.ts";
import {
  adminProjects,
  adminProjectsError,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { count, initials, sinceLine } from "../../lib/format.ts";
import { adminProjectHref, adminUserHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { ChartPanel } from "../../ui/Chart.tsx";
import { Page } from "../../ui/Page.tsx";
import { DayBars } from "../../ui/Plot.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import {
  accountGroups,
  projectGroups,
  signedInHint,
} from "./AccessBoard.model.ts";
import { countLine } from "./AdminProjects.model.ts";
import { lastActive, userCounts } from "./Users.model.ts";

export function AccessBoard() {
  const board = accessBoard.value;
  const people = users.value;
  const teams = adminProjects.value;
  const error =
    accessBoardError.value ?? usersError.value ?? adminProjectsError.value;
  const ready = board !== null && people !== null && teams !== null;
  return (
    <Page
      crumb=""
      title="Access"
      split
      loading={!ready && error === null}
      error={ready ? null : error}
    >
      {ready && (
        <Split aside={<Aside people={people} teams={teams} />}>
          <Body board={board} people={people} teams={teams} />
        </Split>
      )}
    </Page>
  );
}

function Body({
  board,
  people,
  teams,
}: {
  board: AccessBoardResponse;
  people: AdminUser[];
  teams: ProjectSummary[];
}) {
  const now = useNow(60_000);
  const accounts = accountGroups(people, now);
  const projects = projectGroups(teams, board.activeProjectIds);
  return (
    <Rows>
      <SignedIn board={board} users={people.length} />
      <Accounts label="Not seen in 30 days" rows={accounts.unseen} now={now} />
      <Accounts label="Password to change" rows={accounts.password} now={now} />
      <Accounts label="Disabled" rows={accounts.disabled} now={now} />
      <Projects label="Projects without members" rows={projects.empty} />
      <Projects label="No activity in 30 days" rows={projects.quiet} />
    </Rows>
  );
}

function SignedIn({
  board,
  users,
}: {
  board: AccessBoardResponse;
  users: number;
}) {
  const day = useSignal<number | null>(null);
  const starts = useMemo(() => board.days.map((d) => d.start), [board]);
  const series = useMemo(
    () => [{ label: "Signed in", values: board.days.map((d) => d.signedIn) }],
    [board],
  );
  const at = day.value === null ? null : (board.days[day.value] ?? null);
  return (
    <ChartPanel
      label="Signed in"
      hint={signedInHint(board.signedIn, users, at)}
      hintBelow
    >
      {board.signedIn > 0 ? (
        <DayBars
          label="Users signed in per day"
          days={starts}
          series={series}
          stack="activity"
          whole
          words={(v) => (v === 0 ? "0" : count(v))}
          sync="access-board"
          onCursor={(i) => {
            day.value = i;
          }}
        />
      ) : (
        <p class="chart-none">Nobody signed in</p>
      )}
    </ChartPanel>
  );
}

function Accounts({
  label,
  rows,
  now,
}: {
  label: string;
  rows: AdminUser[];
  now: number;
}) {
  if (rows.length === 0) return null;
  return (
    <RowsCard label={label} count={String(rows.length)}>
      {rows.map((u) => (
        <RowsGo key={u.id} href={adminUserHref(u.username)} off={u.disabled}>
          <RowsAvatar>{initials(u.fullName)}</RowsAvatar>
          <RowsTitle name={u.fullName} sub={`@${u.username}`} />
          <RowsMeta>
            {u.disabled
              ? u.role
              : u.lastVisitDay === null
                ? "never signed in"
                : `last seen ${lastActive(u, now)}`}
          </RowsMeta>
        </RowsGo>
      ))}
    </RowsCard>
  );
}

function Projects({ label, rows }: { label: string; rows: ProjectSummary[] }) {
  if (rows.length === 0) return null;
  return (
    <RowsCard label={label} count={String(rows.length)}>
      {rows.map((p) => (
        <RowsGo key={p.id} href={adminProjectHref(p.id)}>
          <RowsTitle name={p.name} sub={countLine(p)} mono />
          <RowsMeta>{sinceLine(p)}</RowsMeta>
        </RowsGo>
      ))}
    </RowsCard>
  );
}

function Aside({
  people,
  teams,
}: {
  people: AdminUser[];
  teams: ProjectSummary[];
}) {
  const n = userCounts(people);
  return (
    <>
      <AsideSection label="Users">
        <AsideLine label="Admins">{count(n.admins)}</AsideLine>
        <AsideLine label="Members">{count(n.members)}</AsideLine>
        <AsideLine label="Disabled" quiet={n.disabled === 0}>
          {count(n.disabled)}
        </AsideLine>
      </AsideSection>
      <AsideSection label="Projects">
        <AsideLine label="Team">{count(teams.length)}</AsideLine>
        <AsideLine label="Personal">{count(people.length)}</AsideLine>
      </AsideSection>
    </>
  );
}
