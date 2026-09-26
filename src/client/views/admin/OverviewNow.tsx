// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Overview's first row, Now: the server's load, polled while the
// page is on screen. The chat and automation pools against their caps,
// and the process's CPU and memory over the last 15 minutes on their
// own cursor. A failed poll keeps the last numbers faded and says since
// when. Also the row head and the tile bones the board's rows share.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { LoadResponse } from "../../../shared/api/admin.ts";
import { serverLoad, serverLoadError } from "../../data/overview.ts";
import { type Failure, size } from "../../lib/format.ts";
import { CodeTag } from "../../ui/CodeTag.tsx";
import { Spark } from "../../ui/Plot.tsx";
import {
  Tile,
  TileMeter,
  TilePlot,
  Tiles,
  TilesGhost,
} from "../../ui/Tiles.tsx";
import {
  automationsTile,
  chatTile,
  cpuTile,
  memoryTile,
  percent,
  sampleLine,
  staleWords,
  zoomed,
} from "./Overview.model.ts";

const NOW_SYNC = "overview-now";

// a row's head: its name and, beside it, its scope or its trouble
export function BoardRow({
  label,
  note,
  stale,
}: {
  label: string;
  note?: ComponentChildren;
  stale?: boolean;
}) {
  return (
    <div class={`overview-section${stale ? " overview-section-stale" : ""}`}>
      <span class="label">{label}</span>
      {note && <span class="overview-section-note">{note}</span>}
    </div>
  );
}

function NowTiles({ load }: { load: LoadResponse }) {
  const cpuAt = useSignal<number | null>(null);
  const rssAt = useSignal<number | null>(null);
  const chats = chatTile(load);
  const runs = automationsTile(load);
  const cpu = cpuTile(load);
  const memory = memoryTile(load);
  const { at, cpu: cpus, rss } = load.samples;
  const cpuSub =
    cpuAt.value !== null && at[cpuAt.value] !== undefined
      ? sampleLine(at[cpuAt.value]!, percent(cpus[cpuAt.value]!))
      : cpu.sub;
  const rssSub =
    rssAt.value !== null && at[rssAt.value] !== undefined
      ? sampleLine(at[rssAt.value]!, size(rss[rssAt.value]!))
      : memory.sub;
  return (
    <Tiles>
      <Tile
        label="Chats"
        figure={chats.figure}
        unit={chats.unit}
        sub={chats.sub}
      >
        <TileMeter share={chats.share} full={chats.full} />
      </Tile>
      <Tile
        label="Automations"
        figure={runs.figure}
        unit={runs.unit}
        sub={runs.sub}
      >
        <TileMeter share={runs.share} full={runs.full} />
      </Tile>
      <Tile label="CPU" figure={cpu.figure} sub={cpuSub}>
        <TilePlot label="CPU over 15 minutes">
          <Spark
            kind="line"
            times={at}
            values={cpus}
            top={1}
            sync={NOW_SYNC}
            onCursor={(i) => {
              cpuAt.value = i;
            }}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Memory"
        figure={memory.figure}
        unit={memory.unit}
        sub={rssSub}
      >
        {load.contained ? (
          <TileMeter share={memory.share} full={memory.full} />
        ) : (
          <TilePlot label="Memory over 15 minutes">
            <Spark
              kind="line"
              times={at}
              values={rss}
              zoom={zoomed}
              sync={NOW_SYNC}
              onCursor={(i) => {
                rssAt.value = i;
              }}
            />
          </TilePlot>
        )}
      </Tile>
    </Tiles>
  );
}

// A row whose read failed: since when its numbers are, or that it has
// none, with the status when the server answered. Nothing while it
// keeps up.
export function Trouble({
  error,
  at,
}: {
  error: Failure | null;
  at: number | null;
}) {
  if (error === null) return null;
  return (
    <>
      {staleWords(at)}
      <CodeTag status={error.status} />
    </>
  );
}

export function NowRow() {
  const load = serverLoad.value;
  const error = serverLoadError.value;
  return (
    <>
      <BoardRow
        label="Now"
        stale={error !== null}
        note={<Trouble error={error} at={load?.at ?? null} />}
      />
      {load ? (
        <div class={error ? "overview-stale" : undefined}>
          <NowTiles load={load} />
        </div>
      ) : (
        <OverviewGhost at={0} />
      )}
    </>
  );
}

export function OverviewGhost({ at }: { at: number }) {
  return (
    <div class="chart-board-ghost" aria-hidden="true">
      <TilesGhost at={at} />
    </div>
  );
}
