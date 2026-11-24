// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile while it loads: who the user is in bones, then each
// section under its own words with its fields and Save in bones, beside
// the account's lines, so the form lands where it waited.

import { emailOn } from "../../data/me.ts";
import { passkeys } from "../../data/passkeys.ts";
import { Bone } from "../../ui/Bones.tsx";
import { RowsList, RowsWaiting } from "../../ui/Rows.tsx";
import { SectionsWaiting } from "../../ui/Section.tsx";
import { FieldBone } from "../../ui/SettingWaiting.tsx";
import { AsideBones, Split } from "../../ui/Split.tsx";
import { WhoWaiting } from "../../ui/Who.tsx";
import { PASSKEYS_TEXT } from "./Passkeys.model.ts";
import { ABOUT_TEXT, EMAIL_HINT } from "./Profile.model.ts";
import "./profile.css";

export function ProfileWaiting() {
  return (
    <Split aside={<AsideBones label="Account" lines={3} />}>
      <SectionsWaiting
        label="Loading your profile"
        class="profile"
        lead={<WhoWaiting class="profile-head" narrow={1} />}
        sections={[
          {
            title: "About you",
            text: ABOUT_TEXT,
            body: (
              <div class="profile-fields">
                <FieldBone kind="wide" at={0} />
                <FieldBone kind="wide" at={2} />
                <div class="field">
                  <span class="label bones-lines-line">
                    <Bone kind="line" at={4} width={10} />
                  </span>
                  <Bone kind="rows" at={5} rows={5} />
                </div>
              </div>
            ),
            foot: true,
          },
          // the switch shows while email is set up, which the sign-in
          // already said
          ...(emailOn.value
            ? [
                {
                  title: "Email",
                  text: null,
                  body: (
                    <div class="field">
                      <RowsList>
                        <RowsWaiting count={1} sub={false} />
                      </RowsList>
                      <span class="hint">{EMAIL_HINT}</span>
                    </div>
                  ),
                  foot: true,
                },
              ]
            : []),
          // the passkeys show where the browser has WebAuthn
          ...(passkeys.support.value
            ? [
                {
                  title: "Passkeys",
                  text: PASSKEYS_TEXT,
                  body: (
                    <div class="field">
                      <RowsList>
                        <RowsWaiting count={1} />
                      </RowsList>
                    </div>
                  ),
                  foot: true,
                },
              ]
            : []),
        ]}
      />
    </Split>
  );
}
