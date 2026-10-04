// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The team docs in every team project (knowledge.ts), each incident's
// RCA and the runbook section it appended, at most 20 versions a file,
// a visit on each working day a user was around, and the automations
// and memory notes as the history left them.

import { lineCount } from "../../../src/server/knowledge/text.ts";
import { tokens } from "../../../src/server/lib/tokens.ts";
import { kindOf } from "../../../src/shared/knowledge.ts";
import { knowledgeName, knowledgeText } from "../knowledge.ts";
import { int, pick, rng } from "../random.ts";
import { KNOWLEDGE_FILES } from "../shapes.ts";
import type { Build } from "./context.ts";
import { hash } from "./ids.ts";
import { DAY, HOUR, LAST_SWEEP, MIN, NOW, RETENTION_DAYS } from "./presets.ts";
import { iso, prose } from "./text.ts";
import type { KnowledgeWrite } from "./timeline.ts";
import { NOTES, RCA } from "./tools.ts";

const sha = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export function knowledge(b: Build, writes: KnowledgeWrite[]) {
  const { q, clock } = b;
  const docs = Array.from({ length: KNOWLEDGE_FILES }, (_, i) => {
    const text = knowledgeText(i);
    return {
      name: knowledgeName(i),
      text,
      digest: sha(text),
      tokens: tokens(text),
    };
  });
  const rcaMeta = RCA.map((text) => ({
    bytes: Buffer.byteLength(text),
    lines: lineCount(text),
    digest: sha(text),
    tokens: tokens(text),
  }));
  const byProject = new Map<string, KnowledgeWrite[]>();
  for (const w of writes) {
    const list = byProject.get(w.project) ?? [];
    list.push(w);
    byProject.set(w.project, list);
  }
  const admin = b.users[0]!;
  for (const team of b.teams) {
    const mine = byProject.get(team.id) ?? [];
    const updates = new Map<number, KnowledgeWrite[]>();
    for (const w of mine) {
      const list = updates.get(w.runbook) ?? [];
      list.push(w);
      updates.set(w.runbook, list);
    }
    for (const [i, doc] of docs.entries()) {
      const fid = b.newId();
      const ups = updates.get(i) ?? [];
      const revision = 1 + ups.length;
      const up = ups.at(-1);
      const tail = (k: number) =>
        ups
          .slice(0, k)
          .map(
            (w) =>
              `\n## RCA ${iso(w.at).slice(0, 13)}\n\n${prose(rng(w.rca), 600)}\n`,
          )
          .join("");
      const text = doc.text + tail(ups.length);
      const author = up ? up.plan.agent : null;
      q.knowledge.run(
        fid,
        team.id,
        doc.name,
        kindOf(doc.name),
        text,
        Buffer.byteLength(text),
        lineCount(text),
        up ? sha(text) : doc.digest,
        up ? doc.tokens + ups.length * 130 : doc.tokens,
        revision,
        author ? "agent" : "user",
        author ? author.id : admin.id,
        author ? author.name : admin.name,
        up?.plan.id ?? null,
        up ? "chat" : null,
        clock.start,
        up?.at ?? clock.start,
      );
      b.bump("knowledge_files");
      for (let rev = Math.max(1, revision - 19); rev <= revision; rev++) {
        const v = rev === 1 ? doc.text : doc.text + tail(rev - 1);
        const w = rev === 1 ? null : ups[rev - 2]!;
        const by = w ? w.plan.agent : null;
        q.version.run(
          b.newId(),
          fid,
          team.id,
          doc.name,
          rev,
          v,
          Buffer.byteLength(v),
          lineCount(v),
          by ? "agent" : "user",
          by ? by.id : admin.id,
          by ? by.name : admin.name,
          w?.plan.id ?? null,
          w ? "chat" : null,
          w?.at ?? clock.start,
        );
        b.bump("knowledge_versions");
      }
    }
    for (const w of mine) {
      const stamp = iso(w.plan.created)
        .slice(0, 16)
        .replace("T", "-")
        .replace(":", "");
      const name = `incidents/rca-${stamp}.md`;
      const m = rcaMeta[w.rca]!;
      const fid = b.newId();
      const a = w.plan.agent;
      q.knowledge.run(
        fid,
        team.id,
        name,
        kindOf(name),
        RCA[w.rca]!,
        m.bytes,
        m.lines,
        m.digest,
        m.tokens,
        1,
        "agent",
        a.id,
        a.name,
        w.plan.id,
        "chat",
        w.at,
        w.at,
      );
      q.version.run(
        b.newId(),
        fid,
        team.id,
        name,
        1,
        RCA[w.rca]!,
        m.bytes,
        m.lines,
        "agent",
        a.id,
        a.name,
        w.plan.id,
        "chat",
        w.at,
      );
      b.bump("knowledge_files");
      b.bump("knowledge_versions");
    }
  }
}

export function visits(b: Build) {
  for (const [ui, u] of b.users.entries()) {
    for (let d = 0; d < b.clock.historyDays; d++) {
      const dayStart = b.clock.start + d * DAY;
      if (dayStart > NOW) break;
      const wd = new Date(dayStart).getUTCDay();
      const r = rng(hash(ui, d, 0x515));
      if (wd === 0 || wd === 6 ? r() > 0.05 : r() > 0.92) continue;
      const at = Math.min(NOW, dayStart + 7 * HOUR + int(r, 0, 120) * MIN);
      b.q.visit.run(u.id, iso(dayStart).slice(0, 10), at);
      b.bump("visits");
    }
  }
}

// the automations as their last fire and run left them, and the notes
export function automationRows(b: Build) {
  const { q, clock, teams } = b;
  const AR = rng(0xa071);
  for (const a of b.automations) {
    if (a.id === null) continue;
    const suspended = a.stopAt !== null;
    let next: number | null = null;
    if (!suspended) {
      next =
        clock.start + Math.floor((NOW - clock.start) / HOUR) * HOUR + a.offset;
      while (next <= NOW) next += HOUR;
    }
    const kept = LAST_SWEEP - RETENTION_DAYS * DAY;
    const lastRun = a.lastRun && a.lastRun.at >= kept ? a.lastRun : null;
    const fired = a.lastFire === null ? null : "schedule";
    const outcome = a.lastFire === null ? null : "run";
    q.automation.run(
      a.id,
      teams[a.team]!.id,
      a.owner.id,
      a.agent.id,
      a.name,
      a.instructions,
      `${Math.floor(a.offset / MIN)} * * * *`,
      RETENTION_DAYS,
      suspended ? a.stopAt : null,
      next,
      a.lastFire,
      a.lastFire,
      fired,
      outcome,
      lastRun?.id ?? null,
      a.lastRun?.status ?? null,
      3 + (suspended ? 1 : 0),
      clock.start,
      suspended ? a.stopAt! : clock.start,
      a.suspendedBy?.id ?? null,
      a.ownMemory ? 1 : 0,
    );
    if (a.ownMemory) {
      q.note.run(
        teams[a.team]!.id,
        a.id,
        pick(AR, NOTES),
        int(AR, 5, 400),
        a.lastRun?.at ?? clock.start,
        null,
        lastRun?.id ?? null,
        a.agent.name,
      );
      b.bump("memory_notes");
    }
  }
  b.bump("automations", b.automations.filter((a) => a.id !== null).length);
  for (const team of teams) {
    q.note.run(
      team.id,
      null,
      pick(AR, NOTES),
      int(AR, 20, 900),
      NOW - int(AR, 1, 400) * HOUR,
      pick(AR, team.members).id,
      null,
      null,
    );
    b.bump("memory_notes");
  }
  for (const u of b.users) {
    if (AR() < 0.3) {
      q.note.run(
        u.personal,
        null,
        pick(AR, NOTES),
        int(AR, 1, 50),
        NOW - int(AR, 1, 2000) * HOUR,
        u.id,
        null,
        null,
      );
      b.bump("memory_notes");
    }
  }
}
