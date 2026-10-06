// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AdminUser } from "../../../shared/api/users.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { me } from "../../data/me.ts";
import { mailOn, users, usersError } from "../../data/users.ts";
import { count, initials } from "../../lib/format.ts";
import { adminUserHref, USERS_HREF } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useListSearch } from "../../lib/search.ts";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTag,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { NewUser } from "./NewUser.tsx";
import { metaLine, stateLine, userCounts } from "./Users.model.ts";

export function Users() {
  if (new URLSearchParams(query.value).has("new")) return <NewUser />;
  return <List />;
}

function List() {
  const list = users.value;
  const error = usersError.value;
  const now = useNow(60_000);
  const { q, shown, count } = useListSearch(list ?? [], (u) => [
    u.username,
    u.fullName,
    u.email,
  ]);
  const meId = me.value?.id;
  return (
    <Page
      steps={[zoneStep("Access")]}
      title="Users"
      split
      actions={<PageNew href={`${USERS_HREF}?new`} label="New user" />}
      loading={list === null && error === null}
      error={error}
    >
      {list !== null && (
        <Split aside={<RolesSection users={list} label="Roles" />}>
          <RowsCard
            label="Users"
            search={<Search query={q} placeholder="Search users" />}
            count={count}
          >
            {shown.length === 0 && <RowsNote>No user matches.</RowsNote>}
            {shown.map((u) => (
              <RowsGo
                key={u.id}
                href={adminUserHref(u.username)}
                off={u.disabled}
              >
                <RowsAvatar>{initials(u.fullName)}</RowsAvatar>
                <RowsTitle
                  name={
                    <>
                      {u.fullName}
                      {u.id === meId && <RowsTag>you</RowsTag>}
                    </>
                  }
                  sub={metaLine(u, mailOn.value)}
                />
                <RowsMeta bad={u.disabled}>{stateLine(u, now)}</RowsMeta>
              </RowsGo>
            ))}
          </RowsCard>
        </Split>
      )}
    </Page>
  );
}

export function RolesSection({
  users,
  label,
}: {
  users: readonly AdminUser[];
  label: string;
}) {
  const n = userCounts(users);
  return (
    <AsideSection label={label}>
      <AsideLine label="Admins">{count(n.admins)}</AsideLine>
      <AsideLine label="Members">{count(n.members)}</AsideLine>
      <AsideLine label="Disabled" quiet={n.disabled === 0}>
        {count(n.disabled)}
      </AsideLine>
    </AsideSection>
  );
}
