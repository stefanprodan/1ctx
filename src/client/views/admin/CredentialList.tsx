// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Web access's Credentials tab: one card of links, a row per credential
// in name order, the name over its prefix and projects, the key file at
// the right, marked when it is missing or cannot be used. The card's
// head searches and counts; New credential is in the page's head. While
// web access is off, one line says no credential is used.

import { useSignal } from "@preact/signals";
import { credentials } from "../../data/credentials.ts";
import { tools } from "../../data/tools.ts";
import { configCredentialHref } from "../../lib/hrefs.ts";
import { matches } from "../../lib/search.ts";
import {
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { keyLine, projectsLine, WEB_OFF_NOTE } from "./Credentials.model.ts";
import "./credentials.css";

export function CredentialList() {
  const q = useSignal("");
  // General's cards stay drawn beside, so the tab waits on its own
  if (credentials.value === null) {
    return (
      <RowsCard label="Credentials">
        <RowsNote>Loading</RowsNote>
      </RowsCard>
    );
  }
  const all = credentials.value;
  const shown = all.filter((c) =>
    matches(q.value, [
      c.name,
      c.prefix,
      c.keyName,
      ...c.projects.map((p) => p.name),
    ]),
  );
  const off = tools.value?.access.mode === "off";
  return (
    <RowsCard
      label="Credentials"
      search={
        <Search
          value={q.value}
          onChange={(next) => {
            q.value = next;
          }}
          placeholder="Search credentials"
        />
      }
      count={
        all.length === 0
          ? undefined
          : shown.length !== all.length
            ? `${shown.length} of ${all.length}`
            : String(all.length)
      }
    >
      {off && (
        <RowsNote>
          <span class="credentials-off">{WEB_OFF_NOTE}</span>
        </RowsNote>
      )}
      {all.length === 0 && <RowsNote>No credentials yet.</RowsNote>}
      {all.length > 0 && shown.length === 0 && (
        <RowsNote>No credential matches.</RowsNote>
      )}
      {shown.map((c) => {
        const key = keyLine(c.keyName, c.key);
        return (
          <RowsGo key={c.id} href={configCredentialHref(c.name)}>
            <RowsTitle
              mono
              name={c.name}
              sub={`${c.prefix} · ${projectsLine(c)}`}
            />
            <RowsMeta bad={key.bad}>{key.text}</RowsMeta>
          </RowsGo>
        );
      })}
    </RowsCard>
  );
}
