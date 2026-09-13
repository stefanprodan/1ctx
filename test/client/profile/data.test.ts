// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile entity follows the signed-in user: a row that answers for
// someone else is dropped, and the previous user's row goes before the
// next load.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  loadProfile,
  profile,
  saveProfile,
} from "../../../src/client/data/profile.ts";
import type { Profile } from "../../../src/shared/contracts/user.ts";

const oana: Profile = {
  id: "u1",
  username: "oana",
  fullName: "Oana",
  email: "oana@example.com",
  disabled: false,
  mustChangePassword: false,
  about: "",
  role: "member",
  createdAt: 1,
};
const admin: Profile = { ...oana, id: "u2", username: "admin", role: "admin" };

let answer: () => Profile;
const realFetch = globalThis.fetch;

beforeEach(() => {
  profile.value = null;
  globalThis.fetch = (async () =>
    Response.json({ user: answer() })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the profile entity", () => {
  test("keeps the row and updates me for the signed-in user", async () => {
    me.value = {
      id: "u1",
      username: "oana",
      fullName: "O",
      role: "member",
      mustChangePassword: false,
    };
    answer = () => oana;
    await loadProfile();
    expect(profile.value).toEqual(oana);
    expect(me.value).toEqual({
      id: "u1",
      username: "oana",
      fullName: "Oana",
      role: "member",
      mustChangePassword: false,
    });
  });

  test("drops a row that answers for someone else", async () => {
    me.value = {
      id: "u2",
      username: "admin",
      fullName: "A",
      role: "admin",
      mustChangePassword: false,
    };
    answer = () => oana;
    await saveProfile({ fullName: "Oana", about: "" });
    expect(profile.value).toBeNull();
    expect(me.value?.id).toBe("u2");
  });

  test("drops a row that answers after the sign out", async () => {
    me.value = null;
    answer = () => oana;
    await loadProfile();
    expect(profile.value).toBeNull();
    expect(me.value).toBeNull();
  });

  test("the previous user's row goes before the next load", async () => {
    profile.value = oana;
    me.value = {
      id: "u2",
      username: "admin",
      fullName: "A",
      role: "admin",
      mustChangePassword: false,
    };
    let seen: Profile | null | undefined;
    answer = () => {
      seen = profile.value;
      return admin;
    };
    await loadProfile();
    expect(seen).toBeNull();
    expect(profile.value).toEqual(admin);
  });
});
