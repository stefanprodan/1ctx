// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The docs each team project holds: runbooks and incident write-ups of
// a few KB to ~60 KB, ~3.6 MB a project. The builder and the driver
// write them, the fake model's commands read them.

import { type Rand, rng } from "./random.ts";

export const TOPICS = [
  "reconcile",
  "helmrelease",
  "timeout",
  "oomkilled",
  "crashloop",
  "certificate",
  "ingress",
  "rollback",
  "latency",
  "quota",
  "drift",
  "webhook",
];

const PROSE = (
  "the controller reconciles the release every five minutes and reports " +
  "drift when the live object differs from the desired state check the " +
  "events in the namespace before a restart and compare the revision " +
  "with the source the alert fires when latency stays above the budget " +
  "for ten minutes and pages the on call engineer who owns the service"
).split(" ");

export function knowledgeName(i: number): string {
  const n = String(i).padStart(3, "0");
  return i % 3 === 2 ? `incidents/inc-${n}.md` : `runbooks/svc-${n}.md`;
}

// a Markdown doc of headed sections, each naming a topic, so rg, grep
// -n '^#' and sed -n ranges find real lines
export function knowledgeText(i: number): string {
  const r: Rand = rng(0xd0c5 + i);
  const target = 2_000 + Math.floor(r() ** 2 * 58_000);
  const out: string[] = [`# ${knowledgeName(i)}: service ${i} operations`, ""];
  let size = 0;
  let section = 0;
  while (size < target) {
    const topic = TOPICS[Math.floor(r() * TOPICS.length)]!;
    out.push(`## ${++section}. ${topic}`, "");
    for (let p = 0; p < 3; p++) {
      const words: string[] = [];
      let k = Math.floor(r() * PROSE.length);
      for (let w = 0; w < 40; w++) words.push(PROSE[k++ % PROSE.length]!);
      words.splice(Math.floor(r() * 40), 0, topic);
      const line = words.join(" ");
      out.push(line, "");
      size += line.length + 1;
    }
    out.push(
      "```sh",
      `kubectl -n svc-${i} get events | grep -i ${topic}`,
      "```",
      "",
    );
  }
  return out.join("\n");
}
