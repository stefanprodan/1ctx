// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Connect agents: the user's access keys, then how to set up each agent
// with its MCP server and the skill. `?new` is the New access key page; the key it makes comes back
// here to be shown once, held by this view so leaving the page drops it.
// The user menu links it under Profile.

import { useSignal } from "@preact/signals";
import type { CreateAccessKeyResponse } from "../../../shared/api/profile.ts";
import { navigate, query } from "../../app/router.ts";
import { accessKeys, accessKeysLimit } from "../../data/access-keys.ts";
import { me } from "../../data/me.ts";
import { Bone } from "../../ui/Bones.tsx";
import { Page } from "../../ui/Page.tsx";
import { Rows, RowsCard } from "../../ui/Rows.tsx";
import { NewCardWaiting } from "../admin/NewCard.tsx";
import { AccessKeys, NewKeyForm } from "./AccessKeys.tsx";
import { CONNECT_HREF } from "./Setup.model.ts";
import { Setup } from "./Setup.tsx";
import "./connect.css";

const STEPS = [
  { label: "Account" },
  { label: "Connect agents", href: CONNECT_HREF },
];

const LEAD =
  "Connect your coding agents to projects over MCP and let them pick up external tasks to work on.";

// a key's row in bones: its icon, its name over its line, its More
// button; a key's line never moves under it as a list row's meta does
function KeyWaiting() {
  return (
    <div
      class="rows-waiting bones-wait"
      role="status"
      aria-label="Loading access keys"
    >
      <div class="rows-item" aria-hidden="true">
        <div class="rows-line rows-waiting-line">
          <Bone kind="icon" at={0} class="rows-waiting-icon" />
          <span class="rows-title">
            <span class="rows-name">
              <Bone kind="line" at={1} width={36} />
              <Bone kind="chip" at={1} class="connect-tag-bone" />
            </span>
            <span class="rows-sub">
              <Bone kind="line" at={2} width={64} />
            </span>
          </span>
          <span class="rows-end">
            <Bone kind="button" at={3} class="connect-more-bone" />
          </span>
        </div>
      </div>
    </div>
  );
}

// the page while the keys load: their card in bones, then the lead and
// the setup, which hold no key and need no answer, in words
function ConnectWaiting() {
  return (
    <div class="connect">
      <Rows>
        <RowsCard label="Access keys" menus>
          <KeyWaiting />
        </RowsCard>
      </Rows>
      <p class="connect-lead">{LEAD}</p>
      <Rows>
        <Setup />
      </Rows>
    </div>
  );
}

export function Connect() {
  const user = me.value;
  const keys = accessKeys.value;
  const shown = useSignal<CreateAccessKeyResponse | null>(null);
  if (new URLSearchParams(query.value).has("new")) {
    return (
      <Page
        steps={STEPS}
        title="New access key"
        loading={keys === null}
        waiting={
          <NewCardWaiting
            label="Loading the new key form"
            fields={["input", "seg", "seg", "seg"]}
            hints={[true, false, true, true]}
          />
        }
      >
        {user && keys !== null && (
          <NewKeyForm
            keys={keys}
            username={user.username}
            onMade={(made) => {
              shown.value = made;
              // replaced, so Back never reopens the form over the key
              navigate(CONNECT_HREF, true);
            }}
          />
        )}
      </Page>
    );
  }
  // the setup holds no key, so it shows whenever there is one to use
  const setup = keys !== null && (accessKeysLimit.value > 0 || keys.length > 0);
  return (
    <Page
      crumb="Account"
      title="Connect agents"
      loading={keys === null}
      waiting={<ConnectWaiting />}
    >
      {user && (
        <div class="connect">
          <Rows>
            <AccessKeys shown={shown} />
          </Rows>
          <p class="connect-lead">{LEAD}</p>
          {setup && (
            <Rows>
              <Setup />
            </Rows>
          )}
        </div>
      )}
    </Page>
  );
}
