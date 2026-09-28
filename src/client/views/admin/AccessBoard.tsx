// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access's board: who signed in over the last 30 days and the users
// who used the app last, then the accounts and the team projects that
// need an admin, a card per group and only when it holds any, each row
// opening its page. Inactive holds the users and the team projects not
// seen in 30 days under one switch. It asks again every 30 seconds
// while seen (watchAccessBoard()). What runs and what it costs are
// Monitor's. The aside counts the users and the projects.

import { useSignal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";
import type { AccessBoardResponse } from "../../../shared/api/access.ts";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import {
  accessBoard,
  accessBoardError,
  watchAccessBoard,
} from "../../data/access-board.ts";
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
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import {
  accountGroups,
  projectGroups,
  recentUsers,
  recentWhen,
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
  useEffect(() => watchAccessBoard(), []);
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
      <Recent rows={recentUsers(board.recent, people)} now={now} />
      <Inactive users={accounts.inactive} projects={projects.quiet} now={now} />
      <Accounts label="Disabled" rows={accounts.disabled} now={now} />
      <Projects label="Projects without members" rows={projects.empty} />
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

function Recent({
  rows,
  now,
}: {
  rows: ReturnType<typeof recentUsers>;
  now: number;
}) {
  if (rows.length === 0) return null;
  return (
    <RowsCard label="Recently active">
      {rows.map((r) => (
        <RowsGo key={r.user.id} href={adminUserHref(r.user.username)}>
          <RowsAvatar>{initials(r.user.fullName)}</RowsAvatar>
          <RowsTitle name={r.user.fullName} sub={`@${r.user.username}`} />
          <RowsMeta brand={r.online}>{recentWhen(r, now)}</RowsMeta>
        </RowsGo>
      ))}
    </RowsCard>
  );
}

type InactiveTab = "users" | "projects";

const INACTIVE_TABS = [
  { value: "users", label: "Users" },
  { value: "projects", label: "Projects" },
] as const;

function Inactive({
  users,
  projects,
  now,
}: {
  users: AdminUser[];
  projects: ProjectSummary[];
  now: number;
}) {
  const picked = useSignal<InactiveTab | null>(null);
  if (users.length === 0 && projects.length === 0) return null;
  // opens on the users unless only projects are inactive
  const tab = picked.value ?? (users.length > 0 ? "users" : "projects");
  return (
    <RowsCard
      label="Inactive"
      count={String(tab === "users" ? users.length : projects.length)}
      action={
        <Seg
          label="Inactive"
          options={INACTIVE_TABS}
          value={tab}
          onPick={(v) => {
            picked.value = v;
          }}
          small
        />
      }
    >
      {tab === "users" ? (
        users.length === 0 ? (
          <RowsNote>Every user signed in within 30 days.</RowsNote>
        ) : (
          users.map((u) => <AccountRow key={u.id} user={u} now={now} />)
        )
      ) : projects.length === 0 ? (
        <RowsNote>Every team project had a turn or a run in 30 days.</RowsNote>
      ) : (
        projects.map((p) => <ProjectRow key={p.id} project={p} />)
      )}
    </RowsCard>
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
        <AccountRow key={u.id} user={u} now={now} />
      ))}
    </RowsCard>
  );
}

function AccountRow({ user: u, now }: { user: AdminUser; now: number }) {
  return (
    <RowsGo href={adminUserHref(u.username)} off={u.disabled}>
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
  );
}

function Projects({ label, rows }: { label: string; rows: ProjectSummary[] }) {
  if (rows.length === 0) return null;
  return (
    <RowsCard label={label} count={String(rows.length)}>
      {rows.map((p) => (
        <ProjectRow key={p.id} project={p} />
      ))}
    </RowsCard>
  );
}

function ProjectRow({ project: p }: { project: ProjectSummary }) {
  return (
    <RowsGo href={adminProjectHref(p.id)}>
      <RowsTitle name={p.name} sub={countLine(p)} mono />
      <RowsMeta>{sinceLine(p)}</RowsMeta>
    </RowsGo>
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
