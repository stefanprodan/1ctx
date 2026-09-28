// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Directory, open to every signed-in user and the same for all:
// every enabled user and every live agent, one list per tab, each row
// leading to their page. A tab is an address, so the head's tabs are
// links and both lists load on either.

import { shortModel } from "../../agents/meta.ts";
import { path } from "../../app/router.ts";
import {
  directoryAgents,
  directoryAgentsError,
  directoryUsers,
  directoryUsersError,
} from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { count, initials } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useListSearch } from "../../lib/search.ts";
import { Fit } from "../../ui/Fit.tsx";
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
import { Tabs } from "../../ui/Tabs.tsx";
import {
  directoryTab,
  directoryTabs,
  localTime,
  roleWords,
} from "./Directory.model.ts";
import "./directory.css";

type ListedUser = NonNullable<typeof directoryUsers.value>[number];
type ListedAgent = NonNullable<typeof directoryAgents.value>[number];

function UsersCard({ list }: { list: ListedUser[] }) {
  const now = useNow(60_000);
  const meId = me.value?.id;
  const { q, shown, count } = useListSearch(list, (u) => [
    u.username,
    u.fullName,
  ]);
  return (
    <RowsCard
      label="Users"
      search={<Search query={q} placeholder="Search users" />}
      count={count}
    >
      {shown.length === 0 && <RowsNote>No user matches.</RowsNote>}
      {shown.map((u) => (
        <RowsGo key={u.id} href={userHref(u.username)}>
          <RowsAvatar>{initials(u.fullName)}</RowsAvatar>
          <RowsTitle
            name={
              <>
                {u.fullName}
                {u.id === meId && <RowsTag>you</RowsTag>}
              </>
            }
            sub={`@${u.username}`}
          />
          <RowsMeta under={localTime(u.tz, now)}>{roleWords(u.role)}</RowsMeta>
        </RowsGo>
      ))}
    </RowsCard>
  );
}

function AgentsCard({ list }: { list: ListedAgent[] }) {
  const { q, shown, count } = useListSearch(list, (a) => [a.name, a.model]);
  return (
    <RowsCard
      label="Agents"
      search={<Search query={q} placeholder="Search agents" />}
      count={count}
    >
      {list.length === 0 && <RowsNote>No agents yet.</RowsNote>}
      {list.length > 0 && shown.length === 0 && (
        <RowsNote>No agent matches.</RowsNote>
      )}
      {shown.map((a) => (
        <RowsGo key={a.id} href={agentHref(a.name)}>
          <RowsAvatar>
            <AvatarIcon name={a.avatar} size={15} />
          </RowsAvatar>
          <RowsTitle
            mono
            name={
              <>
                <span class="cut">@{a.name}</span>
                {a.default && <RowsTag>default</RowsTag>}
              </>
            }
            sub={
              <Fit
                class="directory-model cut"
                long={a.model}
                short={shortModel(a.model)}
              />
            }
          />
        </RowsGo>
      ))}
    </RowsCard>
  );
}

// the counts beside the list: the roles, and the agents with the
// models they run on
function Aside({
  users,
  agents,
}: {
  users: ListedUser[] | null;
  agents: ListedAgent[] | null;
}) {
  const admins = users?.filter((u) => u.role === "admin").length ?? 0;
  const models = new Set(agents?.map((a) => a.model)).size;
  const fallback = agents?.find((a) => a.default);
  return (
    <>
      {users !== null && (
        <AsideSection label="Users">
          <AsideLine label="Admins">{count(admins)}</AsideLine>
          <AsideLine label="Members">{count(users.length - admins)}</AsideLine>
        </AsideSection>
      )}
      {agents !== null && (
        <AsideSection label="Agents">
          <AsideLine label="Models">{count(models)}</AsideLine>
          {fallback !== undefined && (
            <AsideLine label="Default" href={agentHref(fallback.name)} cut>
              @{fallback.name}
            </AsideLine>
          )}
        </AsideSection>
      )}
    </>
  );
}

export function Directory() {
  const tab = directoryTab(path.value);
  const users = directoryUsers.value;
  const agents = directoryAgents.value;
  const tabs = directoryTabs(users?.length, agents?.length);
  const list = tab === "users" ? users : agents;
  const error =
    tab === "users" ? directoryUsersError.value : directoryAgentsError.value;
  return (
    <Page
      crumb=""
      title="Directory"
      split
      loading={list === null && error === null}
      error={error}
    >
      <Split aside={<Aside users={users} agents={agents} />}>
        <div class="directory-list">
          <Tabs tabs={tabs} active={tabs[tab === "users" ? 0 : 1].href} />
          {tab === "users" && users !== null && <UsersCard list={users} />}
          {tab === "agents" && agents !== null && <AgentsCard list={agents} />}
        </div>
      </Split>
    </Page>
  );
}
