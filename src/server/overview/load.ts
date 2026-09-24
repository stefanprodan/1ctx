// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The process's load, kept in memory and never stored: its CPU and its
// resident memory sampled into a ring, which a restart starts over. CPU
// is the time the process ran between two samples over the wall time,
// shared by the cores it may use; availableParallelism() follows a
// container's CPU cap, so a capped process reads against its own share.
// Memory is set against constrainedMemory(), a container's limit when
// one is set and the host's memory otherwise. Neither is machine-wide:
// inside a container the load average and used memory read the host.

import { availableParallelism, totalmem } from "node:os";
import { LOAD_SAMPLES } from "../../shared/api/admin.ts";
import type { Clock } from "../lib/clock.ts";

// what the process says of itself at one moment
export type Reading = {
  // user plus system CPU time since the process started
  cpuMicros: number;
  rss: number;
  // a monotonic time, and the process's age at it
  ms: number;
  uptimeMs: number;
};

export type Probe = {
  read(): Reading;
  cores: number;
  memoryLimit: number;
  contained: boolean;
};

export function processProbe(): Probe {
  const host = totalmem();
  // absent where the platform cannot say; 0 or past the host is no limit
  const limit = process.constrainedMemory?.() ?? 0;
  const contained = limit > 0 && limit < host;
  return {
    read() {
      const cpu = process.cpuUsage();
      return {
        cpuMicros: cpu.user + cpu.system,
        rss: process.memoryUsage.rss(),
        ms: performance.now(),
        uptimeMs: process.uptime() * 1000,
      };
    },
    cores: Math.max(1, availableParallelism()),
    memoryLimit: contained ? limit : host,
    contained,
  };
}

export type Samples = { at: number[]; cpu: number[]; rss: number[] };

export type Sampler = {
  sample(): void;
  samples(): Samples;
};

// The first sample shares the CPU the process used since it started, so
// a fresh ring still says something; every later one the time since
// the sample before.
export function sampler(deps: {
  clock: Clock;
  probe: Probe;
  size?: number;
}): Sampler {
  const size = deps.size ?? LOAD_SAMPLES;
  const ring: Samples = { at: [], cpu: [], rss: [] };
  let last: Reading | null = null;
  return {
    sample() {
      const now = deps.probe.read();
      const cpuMicros = now.cpuMicros - (last?.cpuMicros ?? 0);
      const wallMs = last === null ? now.uptimeMs : now.ms - last.ms;
      const share =
        wallMs > 0 ? cpuMicros / 1000 / wallMs / deps.probe.cores : 0;
      last = now;
      ring.at.push(deps.clock());
      ring.cpu.push(Math.min(1, Math.max(0, share)));
      ring.rss.push(now.rss);
      if (ring.at.length > size) {
        ring.at.shift();
        ring.cpu.shift();
        ring.rss.shift();
      }
    },
    samples: () => ({
      at: [...ring.at],
      cpu: [...ring.cpu],
      rss: [...ring.rss],
    }),
  };
}
