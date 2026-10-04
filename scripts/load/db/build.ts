// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Builds a load test database (the MVP's shape at 1/20, or 100 users)
// through the checkout's own migrate(), so the schema is the branch's,
// then checks it with the app's own store code. Deterministic: a fixed
// clock and seeded generators, so two builds of one preset on one
// schema are one file. Writes <out> and <out>.json, a summary: rows per
// table, sessions by origin, status and archive, bytes per object,
// build times, the schema's commit and the app's reads over it.
//
// bun scripts/load/db/build.ts [--preset bench|small|tiny] [--out PATH]
//   [--no-validate]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { migrate } from "../../../src/server/db/index.ts";
import { FAKE, fakeModelUrl } from "../shapes.ts";
import { contents, validate } from "./check.ts";
import { type Build, statements } from "./context.ts";
import { automationRows, knowledge, visits } from "./files.ts";
import { planHistory } from "./history.ts";
import { idMaker } from "./ids.ts";
import {
  agents,
  automations,
  decider,
  people,
  provider,
  servers,
  skills,
} from "./people.ts";
import { clockOf, NOW, PRESETS } from "./presets.ts";
import { writeTimeline } from "./timeline.ts";

export const OUT_DIR = resolve(import.meta.dir, "../out");
const ROOT = resolve(import.meta.dir, "../../..");

export const defaultDb = (preset: string) =>
  join(OUT_DIR, "db", `${preset}.sqlite`);

// The small tables' secondary indexes are dropped and made again after
// the load: a sort is faster than millions of B-tree inserts. messages
// keeps its own, since building one after would read every overflow
// page for the columns past content.
const REBUILT = [
  "sessions",
  "sends",
  "usage",
  "decision_usage",
  "visits",
  "knowledge_versions",
];

export type BuildOptions = {
  preset: string;
  out?: string;
  validate?: boolean;
  log?: (line: string) => void;
};

function git(...args: string[]) {
  return Bun.spawnSync(["git", "-C", ROOT, ...args])
    .stdout.toString()
    .trim();
}

export async function build(options: BuildOptions) {
  const preset = PRESETS[options.preset];
  if (preset === undefined) {
    throw new Error(
      `unknown preset ${options.preset}: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  const out = resolve(options.out ?? defaultDb(options.preset));
  const log = options.log ?? ((line: string) => console.log(line));
  const t0 = performance.now();
  const seconds = () => +((performance.now() - t0) / 1000).toFixed(1);
  mkdirSync(dirname(out), { recursive: true });
  for (const f of [out, `${out}-wal`, `${out}-shm`, `${out}-journal`]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const db = new Database(out, { create: true });
  db.exec("pragma journal_mode = off");
  db.exec("pragma synchronous = off");
  db.exec("pragma foreign_keys = off");
  db.exec("pragma cache_size = -16000000");
  db.exec("pragma temp_store = memory");
  const clock = clockOf(preset);
  const applied = migrate(db);
  // fixed, so two builds are the same file
  db.query("update migrations set applied_at = ?").run(clock.start);
  // migrate() turns them on again after a rebuild
  db.exec("pragma foreign_keys = off");
  const dropped = db
    .query<{ name: string; sql: string }, []>(
      `select name, sql from sqlite_master where type = 'index' and sql is not null
       and tbl_name in (${REBUILT.map((t) => `'${t}'`).join(", ")}) order by rowid`,
    )
    .all();
  for (const index of dropped) db.exec(`drop index ${index.name}`);

  const newId = idMaker();
  const count: Record<string, number> = {};
  const b: Build = {
    db,
    q: statements(db),
    preset,
    clock,
    newId,
    count,
    bump: (key, n = 1) => {
      count[key] = (count[key] ?? 0) + n;
    },
    provider: {
      id: newId(),
      name: FAKE.provider,
      wire: "openai-compatible",
      url: fakeModelUrl(),
    },
    decider: "",
    users: [],
    agents: [],
    liveAgents: [],
    teams: [],
    automations: [],
    log,
  };
  db.exec("begin");
  provider(b);
  agents(b);
  people(b);
  servers(b);
  skills(b);
  b.decider = newId();
  decider(b);
  automations(b);
  const history = planHistory(b);
  const planned = seconds();
  log(
    `plan: ${history.chats.length} chats (${history.incidents.length} incidents) in ${planned}s`,
  );
  // one transaction: a commit would write every index page the random
  // ids dirtied again; the cache spills data pages as it fills
  const tl = writeTimeline(b, history);
  knowledge(b, tl.knowledgeWrites);
  visits(b);
  automationRows(b);
  db.exec("commit");
  const loaded = seconds();
  log(`load: ${loaded}s`);
  for (const index of dropped) db.exec(index.sql);
  const indexed = seconds();
  const fk = db.query("pragma foreign_key_check").all();
  const integrity = db
    .query<{ integrity_check: string }, []>("pragma integrity_check")
    .all()
    .map((x) => x.integrity_check);
  log(`checks: fk ${fk.length} problems, integrity ${integrity.join("; ")}`);
  if (fk.length > 0 || integrity[0] !== "ok") {
    db.close();
    throw new Error("the built database failed its checks");
  }
  // the file as production keeps it
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  const held = contents(db, tl.running.incident);
  // a statement left open keeps the connection, and its -wal and -shm
  for (const s of Object.values(b.q)) s.finalize();
  db.close(true);

  const devs = b.users.filter((u) => !u.admin);
  const readers = {
    admin: b.users[0]!.name,
    dev2: devs.find((u) => u.teams.length === 2)?.name,
    dev5: devs.find((u) => u.teams.length === 5)?.name,
  };
  const bytes = statSync(out).size;
  const summary: Record<string, unknown> = {
    preset: options.preset,
    file: out,
    bytes,
    gib: +(bytes / 2 ** 30).toFixed(2),
    now: NOW,
    nowIso: new Date(NOW).toISOString(),
    schema: {
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      dbDirty: git("status", "--porcelain", "src/server/db") !== "",
      migrations: applied.length,
      last: applied.at(-1),
    },
    shape: { ...preset, start: new Date(clock.start).toISOString() },
    seconds: { plan: planned, load: loaded, indexes: indexed },
    generated: count,
    ...held,
    running: {
      ...tl.running,
      runs: tl.running.runs.length,
      chats: tl.running.chats.length,
    },
    sample: tl.sample,
    readers,
  };
  if (options.validate !== false) {
    const v = validate(out, readers, tl);
    summary.validation = v;
    const failures = v.failures as string[];
    log(`validation: ${failures.length === 0 ? "ok" : failures.join("; ")}`);
  }
  // an empty WAL and its index, left once every connection closed
  const wal = `${out}-wal`;
  if (existsSync(wal) && statSync(wal).size === 0) {
    unlinkSync(wal);
    if (existsSync(`${out}-shm`)) unlinkSync(`${out}-shm`);
  }
  (summary.seconds as Record<string, number>).total = seconds();
  await Bun.write(`${out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  log(`done: ${out} ${summary.gib} GiB in ${seconds()}s`);
  return summary;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  await build({
    preset: flag("--preset") ?? "bench",
    out: flag("--out"),
    validate: !argv.includes("--no-validate"),
  });
}
