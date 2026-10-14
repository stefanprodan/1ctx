// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tab's title: the most specific part first and the brand last, so
// a narrow tab still says which page it is. Pure, so every page's title
// runs on fixtures.

export const BRAND = "1ctx";

export type TitleParts = {
  // the route's word, the title until the page has read its row
  word: string;
  // the object's name once its row is read: a chat's or a task's
  // title, "Run of" its automation, an automation's name, a file's path
  name: string | null;
  // the project the page is in, from the rail's list
  project: string | null;
  admin: boolean;
};

export function tabTitle(parts: TitleParts | null): string {
  if (parts === null) return BRAND;
  return [
    parts.name || parts.word,
    parts.project,
    parts.admin ? "Admin" : null,
    BRAND,
  ]
    .filter((p) => p !== null && p !== "")
    .join(" · ");
}

export const signInTitle = (): string =>
  tabTitle({ word: "Sign in", name: null, project: null, admin: false });
