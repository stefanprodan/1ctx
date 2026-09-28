// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { credentials } from "../../data/credentials.ts";
import { tools } from "../../data/tools.ts";
import { configCredentialHref } from "../../lib/hrefs.ts";
import { useListSearch } from "../../lib/search.ts";
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
  const all = credentials.value;
  const { q, shown, count } = useListSearch(all ?? [], (c) => [
    c.name,
    c.prefix,
    c.keyName,
    ...c.projects.map((p) => p.name),
  ]);
  // General's cards stay drawn beside, so the tab waits on its own
  if (all === null) {
    return (
      <RowsCard label="Credentials">
        <RowsNote>Loading</RowsNote>
      </RowsCard>
    );
  }
  return (
    <RowsCard
      label="Credentials"
      search={<Search query={q} placeholder="Search credentials" />}
      count={count}
    >
      {tools.value?.access.mode === "off" && (
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
