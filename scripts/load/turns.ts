// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rounds of one turn of the bash shape, as an agent runs them over
// the team's docs: find the doc, read around a line, pull a body into
// /tmp, cut it with jq and awk, write a report, sometimes save one to
// /knowledge. Deterministic per turn key. A quarter of the rounds run
// two commands at once.

import { knowledgeName, TOPICS } from "./knowledge.ts";
import { cumulative, hash32, type Rand, rng } from "./random.ts";
import {
  BASH_CALLS,
  KNOWLEDGE_FILES as FILES,
  ROUNDS,
  SCRATCH,
} from "./shapes.ts";

export type BashRound = string[];

export function bashPlan(key: string): BashRound[] {
  const r = rng(hash32(key));
  const calls = cumulative(r, BASH_CALLS);
  // at most three /tmp slots per chat, so a long chat's scratch stays
  // at a few files
  const slot = hash32(key) % 3;
  const file = () => knowledgeName(Math.floor(r() * FILES));
  const topic = () => TOPICS[Math.floor(r() * TOPICS.length)];
  const lines = () =>
    Math.floor(
      SCRATCH.baseLines + r() ** SCRATCH.tailPower * SCRATCH.tailLines,
    );
  const pods = `/tmp/pods-${slot}.jsonl`;
  let pulled = false;
  const cmds: string[] = [];
  for (let k = 0; k < calls; k++) {
    const step = k < 2 ? k : 2 + ((k - 2) % 5);
    cmds.push(command(r, step, { slot, pods, pulled, file, topic, lines }));
    if (step === 2) pulled = true;
  }
  if (calls > 0 && r() < ROUNDS.saveReport) {
    const name = `reports/r-${hash32(key).toString(36)}.md`;
    cmds.push(
      `mkdir -p /knowledge/reports && cat > /knowledge/${name} <<'EOF'\n${reportBody(r, 4_000)}\nEOF\nwc -l /knowledge/${name}`,
    );
  }
  const rounds: BashRound[] = [];
  for (let i = 0; i < cmds.length; i++) {
    if (i + 1 < cmds.length && r() < ROUNDS.pairChat) {
      rounds.push([cmds[i]!, cmds[i + 1]!]);
      i++;
    } else rounds.push([cmds[i]!]);
  }
  return rounds;
}

type Step = {
  slot: number;
  pods: string;
  pulled: boolean;
  file: () => string;
  topic: () => string | undefined;
  lines: () => number;
};

function command(r: Rand, step: number, s: Step): string {
  switch (step) {
    case 0:
      return `ls /knowledge/runbooks | wc -l; rg -il '${s.topic()}' /knowledge | head -20`;
    case 1: {
      const f = `/knowledge/${s.file()}`;
      const a = 1 + Math.floor(r() * 80);
      return `wc -l ${f}; grep -n '^#' ${f} | head -30; sed -n '${a},${a + 40}p' ${f}`;
    }
    case 2:
      return `seq 1 ${s.lines()} | awk '{printf "{\\"name\\":\\"pod-%d\\",\\"ns\\":\\"ns-%d\\",\\"phase\\":\\"%s\\",\\"restarts\\":%d,\\"node\\":\\"node-%d\\"}\\n",$1,$1%23,($1%17?"Running":"CrashLoopBackOff"),$1%9,$1%40}' > ${s.pods}; wc -c ${s.pods}`;
    case 3:
      return s.pulled
        ? `jq -r 'select(.phase != "Running") | "\\(.ns) \\(.name) \\(.restarts)"' ${s.pods} | sort | head -40; awk -F'"' '{c[$8]++} END {for (k in c) print k, c[k]}' ${s.pods} | sort -k2 -nr | head`
        : `grep -rn '${s.topic()}' /knowledge/incidents | head -30`;
    case 4: {
      const f = `/knowledge/${s.file()}`;
      return `grep -n -i '${s.topic()}' ${f} | head -20; sed -n '1,60p' ${f} | awk 'length > 60' | head -30`;
    }
    case 5: {
      const body = reportBody(r, 3_000 + Math.floor(r() * 9_000));
      const out = `/tmp/report-${s.slot}.md`;
      return `cat > ${out} <<'EOF'\n${body}\nEOF\nwc -l ${out}; grep -c '^-' ${out}`;
    }
    default:
      return `cd /tmp && ls -la && head -c 2000 ${s.pods} 2>/dev/null | tail -5; diff <(sort /tmp/report-${s.slot}.md 2>/dev/null) <(sort /knowledge/${s.file()}) | head -20`;
  }
}

function reportBody(r: Rand, bytes: number): string {
  const out = ["# Findings", ""];
  let size = 0;
  while (size < bytes) {
    const topic = TOPICS[Math.floor(r() * TOPICS.length)];
    const line = `- ns-${Math.floor(r() * 23)} pod-${Math.floor(r() * 9000)}: ${topic} after the rollout, restarts ${Math.floor(r() * 9)}, owner team-${Math.floor(r() * 10)}`;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}
