// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile while it loads: who the user is in bones, then each
// section under its own words with its fields and Save in bones, beside
// the account's lines, so the form lands where it waited.

import { emailOn } from "../../data/me.ts";
import { Bone } from "../../ui/Bones.tsx";
import { RowsList } from "../../ui/Rows.tsx";
import { SectionsWaiting } from "../../ui/Section.tsx";
import { FieldBone } from "../../ui/SettingWaiting.tsx";
import { Split } from "../../ui/Split.tsx";
import { WhoWaiting } from "../../ui/Who.tsx";
import { AsideBones } from "../admin/AdminWaiting.tsx";
import { EMAIL_HINT } from "./Profile.model.ts";
import "./profile.css";

export function ProfileWaiting() {
  return (
    <Split aside={<AsideBones label="Account" lines={3} />}>
      <SectionsWaiting
        label="Loading your profile"
        class="profile"
        lead={<WhoWaiting class="profile-head" narrow />}
        sections={[
          {
            title: "About you",
            text: "What agents should know about you.",
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
                        <div class="rows-line rows-waiting-line">
                          <Bone
                            kind="avatar"
                            at={6}
                            class="rows-waiting-avatar"
                          />
                          <span class="rows-title">
                            <span class="rows-name">
                              <Bone kind="line" at={7} width={34} />
                            </span>
                          </span>
                          <Bone kind="chip" at={8} />
                        </div>
                      </RowsList>
                      <span class="hint">{EMAIL_HINT}</span>
                    </div>
                  ),
                  foot: true,
                },
              ]
            : []),
          {
            title: "Password",
            text: "Changing it signs out every other device.",
            body: (
              <div class="profile-fields">
                <FieldBone kind="wide" at={12} />
                <div class="pair">
                  <FieldBone kind="input" at={14} />
                  <FieldBone kind="input" at={16} />
                </div>
              </div>
            ),
            foot: true,
          },
        ]}
      />
    </Split>
  );
}
