// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { LoadResponse } from "../../../shared/api/admin.ts";
import { serverLoad, serverLoadError } from "../../data/overview.ts";
import { size } from "../../lib/format.ts";
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
  cpuTile,
  memoryTile,
  percent,
  runningTile,
  sampleLine,
  zoomed,
} from "./Overview.model.ts";

const NOW_SYNC = "overview-now";

function NowTiles({ load }: { load: LoadResponse }) {
  const cpuAt = useSignal<number | null>(null);
  const rssAt = useSignal<number | null>(null);
  const chats = runningTile(load);
  const runs = automationsTile(load);
  const cpu = cpuTile(load);
  const memory = memoryTile(load);
  const { at, cpu: cpus, rss } = load.samples;
  const atCursor = (
    i: number | null,
    values: number[],
    words: (v: number) => string,
    rest: string,
  ) =>
    i !== null && at[i] !== undefined
      ? sampleLine(at[i]!, words(values[i]!))
      : rest;
  const cpuSub = atCursor(cpuAt.value, cpus, percent, cpu.sub);
  const rssSub = atCursor(rssAt.value, rss, size, memory.sub);
  return (
    <Tiles>
      <Tile
        label="Chats and runs"
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

export function NowRow() {
  // a server just started has no sample yet, which would draw as 0%
  const read = serverLoad.value;
  const load = read && read.samples.at.length > 0 ? read : null;
  const error = serverLoadError.value;
  return load ? (
    <div class={error ? "chart-stale" : undefined}>
      <NowTiles load={load} />
    </div>
  ) : (
    <OverviewGhost at={0} />
  );
}

export function OverviewGhost({ at }: { at: number }) {
  return (
    <div class="chart-board-ghost" aria-hidden="true">
      <TilesGhost at={at} />
    </div>
  );
}
