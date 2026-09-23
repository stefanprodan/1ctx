// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The database as a board: four tiles (on disk, free space, growth,
// the write-ahead log), then the areas beside one area's tables and
// the largest rows beside retention, then a faint line of file facts.
// Areas and tables are pages on disk, Largest and Retention the bytes
// the rows store, so each panel names its unit. Loaded on arrival and
// on Refresh; the first load draws the board in bones, a refresh fades
// the last answer until the next lands.

import { useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import type { StorageResponse } from "../../../shared/api/admin.ts";
import {
  loadStorage,
  storage,
  storageError,
  storageLoading,
} from "../../data/overview.ts";
import { clock } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import {
  Bars,
  BarsGhost,
  Bone,
  ChartFoot,
  ChartPanel,
  Meter,
  Spark,
  Stack,
  Swatch,
} from "../../ui/Chart.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsFilters } from "../../ui/Rows.tsx";
import {
  Tile,
  TileGhost,
  TileMeter,
  TilePlot,
  Tiles,
} from "../../ui/Tiles.tsx";
import {
  AREA_NAMES,
  added,
  areaBars,
  areasFoot,
  cleanedLine,
  commas,
  dayWord,
  factsLine,
  freeWords,
  keptLine,
  type LargestKind,
  largestLine,
  perDay,
  pickedArea,
  share,
  size,
  sizeByDay,
  sizeParts,
  tableBars,
} from "./Storage.model.ts";
import "./storage.css";

const SYNC = "storage";

function StorageTiles({ answer }: { answer: StorageResponse }) {
  const { file, days, before } = answer;
  // the day under either sparkline's cursor, shared through the sync key
  const day = useSignal<number | null>(null);
  const onDisk = file.bytes + file.walBytes;
  const series = useMemo(
    () => ({
      starts: days.map((d) => d.start),
      sizes: sizeByDay(onDisk, days),
      bytes: days.map((d) => d.bytes),
    }),
    [days, onDisk],
  );
  const grown = added(days);
  const free = file.freePages * file.pageSize;
  const i = day.value;
  const at = i === null ? null : days[i];
  const disk = sizeParts(onDisk);
  const growth = perDay(grown, days.length);
  const onCursor = (index: number | null) => {
    day.value = index;
  };
  return (
    <Tiles>
      <Tile
        label="On disk"
        figure={disk.figure}
        unit={disk.unit}
        sub={
          at && i !== null
            ? `${dayWord(at.start)} · ${size(series.sizes[i])}`
            : `+${size(grown)} in ${days.length} days`
        }
      >
        <TilePlot label={`Size over ${days.length} days`}>
          <Spark
            kind="line"
            days={series.starts}
            values={series.sizes}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Free space"
        figure={sizeParts(free).figure}
        unit={sizeParts(free).unit}
        sub={freeWords(file)}
      >
        <TileMeter share={file.bytes > 0 ? free / file.bytes : 0} />
      </Tile>
      <Tile
        label="Growth"
        figure={growth.figure}
        unit={growth.unit}
        sub={
          at
            ? `${dayWord(at.start)} · +${size(at.bytes)}`
            : `${size(days.length > 0 ? before / days.length : 0)} a day the ${days.length} before`
        }
      >
        <TilePlot label="Bytes added per day">
          <Spark
            kind="bars"
            days={series.starts}
            values={series.bytes}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Write-ahead log"
        figure={sizeParts(file.walBytes).figure}
        unit={sizeParts(file.walBytes).unit}
        sub="folded in at each checkpoint"
      />
    </Tiles>
  );
}

function AreasPanels({ answer }: { answer: StorageResponse }) {
  const picked = useSignal<string | null>(null);
  const areasHint = useSignal<string | null>(null);
  const tablesHint = useSignal<string | null>(null);
  const area = pickedArea(answer.areas, picked.value);
  const bars = areaBars(answer.areas).map((b) => ({
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
  }));
  return (
    <>
      <ChartPanel label="Areas" hint={areasHint.value ?? "on disk"}>
        <Bars
          bars={bars}
          picked={area?.key}
          onPick={(key) => {
            picked.value = key;
            tablesHint.value = null;
          }}
          onHover={(hint) => {
            areasHint.value = hint;
          }}
        />
        <ChartFoot>
          {areasFoot(answer.areas)} · pick an area for its tables
        </ChartFoot>
      </ChartPanel>
      <ChartPanel
        label={area ? `Tables in ${AREA_NAMES[area.key]}` : "Tables"}
        hint={
          tablesHint.value ??
          (area
            ? `${commas(area.rows)} ${area.rows === 1 ? "row" : "rows"}`
            : "")
        }
      >
        {area && (
          <Bars
            wide
            bars={tableBars(area).map((t) => ({
              key: t.key,
              name: t.name,
              value: t.value,
              hint: t.hint,
              label: t.size,
              mono: !t.faint,
              faint: t.faint,
            }))}
            onHover={(hint) => {
              tablesHint.value = hint;
            }}
          />
        )}
      </ChartPanel>
    </>
  );
}

const KIND_ICONS: Record<LargestKind, IconName> = {
  projects: "hash",
  chats: "chat",
  tasks: "bolt",
};

function LargestPanel({ answer }: { answer: StorageResponse }) {
  const kind = useSignal<LargestKind>("projects");
  const rows = answer.largest[kind.value];
  const top = rows[0]?.bytes ?? 0;
  const filters = (["projects", "chats", "tasks"] as const).map((k) => ({
    label: k === "projects" ? "Projects" : k === "chats" ? "Chats" : "Tasks",
    on: kind.value === k,
    onPick: () => {
      kind.value = k;
    },
  }));
  return (
    <ChartPanel
      label="Largest"
      hint="stored"
      action={<RowsFilters label="Largest" filters={filters} />}
    >
      {rows.length === 0 ? (
        <p class="storage-none">Nothing stored yet</p>
      ) : (
        <div class="storage-tops">
          {rows.map((row, i) => {
            const line = largestLine(kind.value, row);
            const inner = (
              <>
                <Icon
                  name={line.href ? KIND_ICONS[kind.value] : "lock"}
                  size={14}
                  class="storage-top-icon"
                />
                <span class="storage-top-words">
                  <span
                    class={`storage-top-name cut${line.mono ? " chart-mono" : ""}`}
                  >
                    {line.name}
                  </span>
                  <span class="storage-top-sub cut">{line.sub}</span>
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
      <div class="storage-grid">
        <AreasPanels answer={answer} />
        <LargestPanel answer={answer} />
        <RetentionPanel answer={answer} />
      </div>
      <p class="storage-facts">{factsLine(answer.file)}</p>
    </>
  );
}

// the board while its first answer loads: the same tiles and panels
// with their heads, bones where the numbers go, pulsing one after
// another, each panel at its loaded height
const AREA_WIDTHS = [100, 36, 19, 11, 8, 5, 2, 1, 1];
const TABLE_WIDTHS = [100, 4, 2, 2, 9];
const TEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SIX = [0, 1, 2, 3, 4, 5];

function BoardGhost() {
  const itemGhost = (at: number) => (
    <div key={at} class="storage-item">
      <Bone kind="name" at={at} />
      <span />
      <Bone kind="value" at={at + 1} />
    </div>
  );
  return (
    <div class="storage-ghost" aria-hidden="true">
      <Tiles>
        {[0, 4, 8, 12].map((at) => (
          <TileGhost key={at} at={at} />
        ))}
      </Tiles>
      <div class="storage-grid">
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
                  <Bone kind="title" at={61 + n} />
                  <Bone kind="sub" at={62 + n} />
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
  const status = busy
    ? answer
      ? "Refreshing"
      : "Loading"
    : error && answer
      ? "Did not refresh"
      : answer
        ? `Loaded ${clock(answer.readAt)}`
        : "";
  const actions = (
    <>
      <span
        class={`storage-loaded${!busy && error && answer ? " storage-loaded-failed" : ""}`}
        aria-live="polite"
      >
        {status}
        {!busy && error && answer && error.status !== null && (
          <span class="code-tag">HTTP {error.status}</span>
        )}
      </span>
      <button
        type="button"
        class="btn btn-small"
        disabled={busy}
        onClick={() => void loadStorage()}
      >
        <Icon
          name={busy ? "spinner" : "redo"}
          size={12}
          class={busy ? "storage-spin" : undefined}
        />
        Refresh
      </button>
    </>
  );
  return (
    <Page
      crumb="Admin"
      title="Storage"
      actions={actions}
      error={answer === null && !busy ? error : null}
    >
      <div
        class={`storage${busy && answer ? " storage-stale" : ""}`}
        aria-busy={busy}
      >
        {answer ? <Board answer={answer} /> : <BoardGhost />}
      </div>
    </Page>
  );
}
