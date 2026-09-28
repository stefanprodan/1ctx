// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { initials } from "../../lib/format.ts";
import { adminUserHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { countOf } from "../../lib/search.ts";
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
import { Split } from "../../ui/Split.tsx";
import {
  accountGroups,
  BOARD_DAYS,
  projectGroups,
  recentUsers,
  recentWhen,
  signedInHint,
} from "./AccessBoard.model.ts";
import { ProjectCountsSection, ProjectRow } from "./AdminProjects.tsx";
import { lastActive } from "./Users.model.ts";
import { RolesSection } from "./Users.tsx";

export function AccessBoard() {
  const board = accessBoard.value;
  const list = users.value;
  const teams = adminProjects.value;
  const error =
    accessBoardError.value ?? usersError.value ?? adminProjectsError.value;
  const ready = board !== null && list !== null && teams !== null;
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
        <Split
          aside={
            <>
              <RolesSection users={list} label="Users" />
              <ProjectCountsSection teams={teams} users={list} />
            </>
          }
        >
          <Body board={board} list={list} teams={teams} />
        </Split>
      )}
    </Page>
  );
}

function Body({
  board,
  list,
  teams,
}: {
  board: AccessBoardResponse;
  list: AdminUser[];
  teams: ProjectSummary[];
}) {
  const now = useNow(60_000);
  const accounts = accountGroups(list, now);
  const projects = projectGroups(teams, board.activeProjectIds);
  return (
    <Rows>
      <SignedIn board={board} users={list.length} />
      <Recent rows={recentUsers(board.recent, list)} now={now} />
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
  const tab = picked.value ?? (users.length > 0 ? "users" : "projects");
  const shown = tab === "users" ? users.length : projects.length;
  return (
    <RowsCard
      label="Inactive"
      count={countOf(shown, shown)}
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
          <RowsNote>{`Every user signed in within ${BOARD_DAYS} days.`}</RowsNote>
        ) : (
          users.map((u) => <AccountRow key={u.id} user={u} now={now} />)
        )
      ) : projects.length === 0 ? (
        <RowsNote>
          {`Every team project had a turn or a run in ${BOARD_DAYS} days.`}
        </RowsNote>
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
