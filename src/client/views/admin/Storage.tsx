// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import type { StorageResponse } from "../../../shared/api/admin.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  loadStorage,
  storage,
  storageError,
  storageLoading,
} from "../../data/overview.ts";
import { pluralCommas, share, size, sizeParts } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { BarsGhost, Bone } from "../../ui/Bones.tsx";
import {
  BarsPanel,
  ChartFoot,
  ChartPanel,
  Meter,
  Stack,
  Swatch,
} from "../../ui/Chart.tsx";
import { Loaded } from "../../ui/Loaded.tsx";
import { Page } from "../../ui/Page.tsx";
import { Spark } from "../../ui/Plot.tsx";
import { RowsFilters } from "../../ui/Rows.tsx";
import {
  Tile,
  TileMeter,
  TilePlot,
  Tiles,
  TilesGhost,
} from "../../ui/Tiles.tsx";
import {
  AREA_NAMES,
  addedByDay,
  areaBars,
  areasFoot,
  cleanedLine,
  factsLine,
  freeWords,
  growthDay,
  growthWords,
  keptLine,
  type LargestKind,
  largestLine,
  logHeights,
  perDay,
  pickedArea,
  rowsDay,
  rowsTile,
  tableBars,
  walWords,
} from "./Storage.model.ts";
import "./storage.css";
import { CONFIG_STORAGE_HREF } from "../../lib/hrefs.ts";

const SYNC = "storage";

function StorageTiles({ answer }: { answer: StorageResponse }) {
  const { file, days, before } = answer;
  const day = useSignal<number | null>(null);
  const onDisk = file.bytes + file.walBytes;
  const series = useMemo(
    () => ({
      starts: days.map((d) => d.start),
      sums: addedByDay(days),
      rows: logHeights(days.map((d) => d.rows)),
    }),
    [days],
  );
  const grown = series.sums.at(-1) ?? 0;
  const free = file.freePages * file.pageSize;
  const i = day.value;
  const at = i === null ? null : days[i];
  const disk = sizeParts(onDisk);
  const rows = rowsTile(answer.areas);
  const growth = perDay(grown, days.length);
  const onCursor = (index: number | null) => {
    day.value = index;
  };
  return (
    <Tiles>
      <Tile
        label="Database"
        figure={rows.figure}
        unit={rows.unit}
        sub={at ? rowsDay(at) : rows.sub}
      >
        <TilePlot label="Rows added per day">
          <Spark
            kind="bars"
            times={series.starts}
            values={series.rows}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Size"
        figure={disk.figure}
        unit={disk.unit}
        sub={freeWords(file)}
      >
        <TileMeter share={onDisk > 0 ? 1 - free / onDisk : 0} />
      </Tile>
      <Tile
        label="Growth"
        figure={growth.figure}
        unit={growth.unit}
        sub={
          at && i !== null
            ? growthDay(at.start, series.sums[i])
            : growthWords(before, days.length)
        }
      >
        <TilePlot label={`Stored bytes added over ${days.length} days`}>
          <Spark
            kind="line"
            times={series.starts}
            values={series.sums}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Write-ahead log"
        figure={sizeParts(file.walBytes).figure}
        unit={sizeParts(file.walBytes).unit}
        sub={walWords(file)}
      >
        <TileMeter share={onDisk > 0 ? file.walBytes / onDisk : 0} />
      </Tile>
    </Tiles>
  );
}

// Areas and Tables count pages in the file, Largest and Retention the
// bytes the rows store, so each panel names its unit
function AreasPanels({ answer }: { answer: StorageResponse }) {
  const picked = useSignal<string | null>(null);
  const area = pickedArea(answer.areas, picked.value);
  const tables = area ? tableBars(area) : [];
  return (
    <>
      <BarsPanel
        label="Areas"
        bars={areaBars(answer.areas).map((b) => ({
          key: b.key,
          name: b.name,
          value: b.value,
          hint: b.hint,
          label: (
            <>
              {b.size}
              <span class="chart-share">{b.share}</span>
            </>
          ),
        }))}
        picked={area?.key}
        onPick={(key) => {
          picked.value = key;
        }}
      >
        <ChartFoot>
          {areasFoot(answer.areas)} · pick an area for its tables
        </ChartFoot>
      </BarsPanel>
      <BarsPanel
        key={area?.key}
        label={area ? `Tables in ${AREA_NAMES[area.key]}` : "Tables"}
        rest={area ? pluralCommas(area.rows, "row", "rows") : undefined}
        wide
        bars={tables.map((t) => ({
          key: t.key,
          name: t.name,
          value: t.value,
          hint: t.hint,
          label: t.size,
          mono: !t.faint,
          faint: t.faint,
        }))}
      />
    </>
  );
}

const KINDS: { key: LargestKind; label: string; icon: IconName }[] = [
  { key: "projects", label: "Projects", icon: "hash" },
  { key: "chats", label: "Chats", icon: "chat" },
  { key: "tasks", label: "Tasks", icon: "bolt" },
];

function LargestPanel({ answer }: { answer: StorageResponse }) {
  const kind = useSignal<LargestKind>("projects");
  const rows = answer.largest[kind.value];
  const top = rows[0]?.bytes ?? 0;
  const icon = KINDS.find((k) => k.key === kind.value)!.icon;
  const filters = KINDS.map((k) => ({
    label: k.label,
    on: kind.value === k.key,
    onPick: () => {
      kind.value = k.key;
    },
  }));
  return (
    <ChartPanel
      label="Largest"
      hint="stored"
      action={<RowsFilters label="Largest" filters={filters} />}
    >
      {rows.length === 0 ? (
        <p class="chart-none">Nothing stored yet</p>
      ) : (
        <div class="storage-tops">
          {rows.map((row, i) => {
            const line = largestLine(kind.value, row);
            const inner = (
              <>
                <Icon
                  name={line.href ? icon : "lock"}
                  size={14}
                  class="storage-top-icon"
                />
                <span class="storage-top-words">
                  <span
                    class={`storage-top-name${line.mono ? " chart-mono" : ""}`}
                  >
                    {line.name}
                  </span>
                  <span class="storage-top-sub">{line.sub}</span>
                </span>
                <span class="storage-top-size">
                  <span class="chart-value">{size(row.bytes)}</span>
                  <Meter share={top > 0 ? row.bytes / top : 0} />
                </span>
              </>
            );
            return line.href ? (
              <a
                key={row.id}
                class="storage-top storage-top-go"
                href={line.href}
              >
                {inner}
              </a>
            ) : (
              <div key={`personal-${i}`} class="storage-top">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </ChartPanel>
  );
}

function RetentionPanel({ answer }: { answer: StorageResponse }) {
  const { kept, cleaned } = answer.retention;
  const keptBytes = kept.reduce((sum, k) => sum + k.bytes, 0);
  const cleanedBytes = cleaned.reduce((sum, c) => sum + c.bytes, 0);
  const whole = keptBytes + cleanedBytes;
  const item = (name: string, sub: string, bytes: number) => (
    <div key={name} class="storage-item">
      <span>{name}</span>
      <span class="storage-item-sub">{sub}</span>
      <span class="chart-value">{size(bytes)}</span>
    </div>
  );
  const head = (part: "first" | "second", words: string, bytes: number) => (
    <span class="storage-col-head">
      <Swatch part={part} />
      {words}
      <b class="chart-strong">{size(bytes)}</b>
      <span class="storage-col-share">{share(bytes, whole)}</span>
    </span>
  );
  return (
    <ChartPanel label="Retention" hint="stored · swept hourly">
      <Stack
        first={keptBytes}
        second={cleanedBytes}
        label={`Kept until deleted ${size(keptBytes)}, cleaned on a schedule ${size(cleanedBytes)}`}
      />
      <div class="storage-columns">
        <div>
          {head("first", "Kept until deleted", keptBytes)}
          {kept.map((k) => {
            const l = keptLine(k.key);
            return item(l.name, l.sub, k.bytes);
          })}
        </div>
        <div>
          {head("second", "Cleaned on a schedule", cleanedBytes)}
          {cleaned.map((c) => {
            const l = cleanedLine(c.key, c.days);
            return item(l.name, l.sub, c.bytes);
          })}
        </div>
      </div>
    </ChartPanel>
  );
}

function Board({ answer }: { answer: StorageResponse }) {
  return (
    <>
      <StorageTiles answer={answer} />
      <div class="chart-grid">
        <AreasPanels answer={answer} />
        <LargestPanel answer={answer} />
        <RetentionPanel answer={answer} />
      </div>
      <p class="chart-facts">{factsLine(answer.file)}</p>
    </>
  );
}

const AREA_WIDTHS = [100, 36, 19, 11, 8, 5, 2, 1, 1];
const TABLE_WIDTHS = [100, 4, 2, 2, 9];
const TEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SIX = [0, 1, 2, 3, 4, 5];

function BoardGhost() {
  const itemGhost = (at: number) => (
    <div key={at} class="storage-item">
      <Bone kind="label" at={at} />
      <span />
      <Bone kind="value" at={at + 1} />
    </div>
  );
  return (
    <div class="chart-board-ghost" aria-hidden="true">
      <TilesGhost at={0} />
      <div class="chart-grid">
        <ChartPanel label="Areas">
          <BarsGhost widths={AREA_WIDTHS} at={16} />
          <ChartFoot>
            <Bone kind="title" at={44} />
          </ChartFoot>
        </ChartPanel>
        <ChartPanel label="Tables">
          <BarsGhost widths={TABLE_WIDTHS} at={45} wide />
        </ChartPanel>
        <ChartPanel label="Largest">
          <div class="storage-tops">
            {TEN.map((n) => (
              <div key={n} class="storage-top">
                <Bone kind="icon" at={60 + n} />
                <span class="storage-top-words">
                  <Bone kind="name" at={61 + n} />
                  <Bone kind="title" at={62 + n} />
                </span>
                <span class="storage-top-size">
                  <Bone kind="value" at={63 + n} />
                  <Bone kind="meter" at={64 + n} />
                </span>
              </div>
            ))}
          </div>
        </ChartPanel>
        <ChartPanel label="Retention">
          <div class="chart-stack-wrap">
            <Bone kind="stack" at={75} />
          </div>
          <div class="storage-columns">
            <div>{SIX.map((n) => itemGhost(76 + n * 2))}</div>
            <div>{SIX.map((n) => itemGhost(88 + n * 2))}</div>
          </div>
        </ChartPanel>
      </div>
    </div>
  );
}

export function Storage() {
  const answer = storage.value;
  const error = storageError.value;
  const busy = storageLoading.value;
  const actions = (
    <>
      {/* off on a phone, where the head has room only for the crumb */}
      <a class="btn btn-small storage-limits" href={CONFIG_STORAGE_HREF}>
        Limits
      </a>
      <Loaded
        readAt={answer?.readAt ?? null}
        busy={busy}
        error={error}
        onRefresh={() => void loadStorage()}
      />
    </>
  );
  return (
    <Page
      steps={[zoneStep("Monitor")]}
      title="Storage"
      actions={actions}
      error={answer === null && !busy ? error : null}
    >
      <div
        class={`chart-board${busy && answer ? " chart-stale" : ""}`}
        aria-busy={busy}
      >
        {answer ? <Board answer={answer} /> : <BoardGhost />}
      </div>
    </Page>
  );
}
