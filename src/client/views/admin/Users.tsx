// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access › Users: one card of links, a row per user in username order,
// the initials, the full name over the handle and the email, the role
// and when they were last active at the right, so an admin finds the
// accounts nobody uses. New user is in the page's head and opens its
// own page; a row opens the user's page. The aside counts them.

import { useSignal } from "@preact/signals";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { me } from "../../data/me.ts";
import { users, usersError } from "../../data/users.ts";
import { count, initials } from "../../lib/format.ts";
import { adminUserHref, USERS_HREF } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
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
  const q = useSignal("");
  const now = useNow(60_000);
  const all = list ?? [];
  const shown = all.filter((u) =>
    matches(q.value, [u.username, u.fullName, u.email]),
  );
  const meId = me.value?.id;
  return (
    <Page
      steps={[zoneStep("Access")]}
      title="Users"
      split
      actions={
        <a class="btn btn-small" href={`${USERS_HREF}?new`}>
          <Icon name="plus" size={14} />
          New user
        </a>
      }
      loading={list === null && error === null}
      error={error}
    >
      {list !== null && (
        <Split aside={<Aside />}>
          <RowsCard
            label="Users"
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search users"
              />
            }
            count={
              shown.length !== all.length
                ? `${shown.length} of ${all.length}`
                : String(all.length)
            }
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
                  sub={metaLine(u)}
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

function Aside() {
  const n = userCounts(users.value ?? []);
  return (
    <AsideSection label="Roles">
      <AsideLine label="Admins">{count(n.admins)}</AsideLine>
      <AsideLine label="Members">{count(n.members)}</AsideLine>
      <AsideLine label="Disabled" quiet={n.disabled === 0}>
        {count(n.disabled)}
      </AsideLine>
    </AsideSection>
  );
}
