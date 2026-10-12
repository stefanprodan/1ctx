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
import { Page } from "../../ui/Page.tsx";
import { Rows } from "../../ui/Rows.tsx";
import { AccessKeys, NewKeyForm } from "./AccessKeys.tsx";
import { CONNECT_HREF } from "./Setup.model.ts";
import { Setup } from "./Setup.tsx";
import "./connect.css";

const STEPS = [
  { label: "Account" },
  { label: "Connect agents", href: CONNECT_HREF },
];

export function Connect() {
  const user = me.value;
  const keys = accessKeys.value;
  const shown = useSignal<CreateAccessKeyResponse | null>(null);
  if (new URLSearchParams(query.value).has("new")) {
    return (
      <Page steps={STEPS} title="New access key" loading={keys === null}>
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
    <Page crumb="Account" title="Connect agents" loading={keys === null}>
      {user && (
        <div class="connect">
          <Rows>
            <AccessKeys shown={shown} />
          </Rows>
          <p class="connect-lead">
            Connect your coding agents to projects over MCP and let them pick up
            tasks to work on.
          </p>
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
