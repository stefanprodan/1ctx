// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import type { OverviewTotals } from "../../../shared/api/admin.ts";
import { overview, overviewError } from "../../data/overview.ts";
import { count, money } from "../../lib/format.ts";
import { USAGE_HREF } from "../../lib/hrefs.ts";
import { AsideLine, AsideRead, AsideSection } from "../../ui/Split.tsx";

export function UsageSection<T>({
  value,
  label = "Last 30 days",
  children,
}: {
  value: T | null | undefined;
  label?: string;
  children: (value: T) => ComponentChildren;
}) {
  return (
    <AsideRead
      label={label}
      action={
        <a class="split-link" href={USAGE_HREF}>
          Usage
        </a>
      }
      value={value}
    >
      {children}
    </AsideRead>
  );
}

export function SpendLines({
  label,
  count: n,
  tokens,
  cost,
}: {
  label: "Turns" | "Answers";
  count: number;
  tokens: number;
  cost: number | null;
}) {
  return (
    <>
      <AsideLine label={label}>{count(n)}</AsideLine>
      <AsideLine label="Tokens">{count(tokens)}</AsideLine>
      <AsideLine label="Cost">
        {cost === null ? "not priced" : money(cost)}
      </AsideLine>
    </>
  );
}

// the Monitor may hold another range: the aside says only 30 days
export function overviewTotals(): OverviewTotals | null | undefined {
  const answer = overview.value;
  if (answer?.range === "30d") return answer.totals;
  return overviewError.value === null ? undefined : null;
}

export function KeyFilesSection({
  files,
  reader,
}: {
  files: readonly string[];
  // what reads the file: a label ("unused", a name, "2 credentials"),
  // and its page when one reads it
  reader: (file: string) => { label: string; href?: string; quiet?: boolean };
}) {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return (
    <AsideSection label="Key files">
      {sorted.length === 0 ? (
        <p class="split-empty">None in the secrets directory.</p>
      ) : (
        sorted.map((file) => {
          const read = reader(file);
          return (
            <AsideLine
              key={file}
              label={`${file}.key`}
              cut
              href={read.href}
              quiet={read.quiet}
            >
              {read.label}
            </AsideLine>
          );
        })
      )}
    </AsideSection>
  );
}

const TOP = 5;

export function TopSection({
  label,
  rows,
}: {
  label: string;
  rows: readonly { name: string; value: number; href?: string }[];
}) {
  if (rows.length === 0) return null;
  return (
    <AsideSection label={label}>
      {rows.slice(0, TOP).map((row) => (
        <AsideLine key={row.name} label={row.name} cut href={row.href}>
          {count(row.value)}
        </AsideLine>
      ))}
    </AsideSection>
  );
}
