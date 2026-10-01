// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type JobRunner,
  type RepoCredential,
  type RepoFields,
  type RepoLimits,
  reposArea,
  threadJobs,
} from "../../../src/server/repos/index.ts";
import type { RepoKind } from "../../../src/shared/contracts/repo.ts";
import { collectLogs } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import {
  COMMIT,
  cacheDir,
  fakeHost,
  type HostAnswer,
  NEXT_COMMIT,
  redirect,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PAGE = "https://git.test/acme/widgets";
const ARCHIVE = `${PAGE}/archive/HEAD.tar.gz`;
const API = "https://git.test/api/v3/repos/acme/widgets/";
const CODELOAD = "https://codeload.git.test/acme/widgets/legacy.tar.gz";

const credential: RepoCredential = {
  id: "c1",
  name: "github",
  keyName: "http-github",
  prefix: "https://git.test/api/v3/repos/acme/",
  header: "authorization",
  template: "Bearer {key}",
  methods: ["GET"],
  projectIds: ["p1"],
};

type Options = {
  answers?: Record<string, HostAnswer>;
  limits?: Partial<RepoLimits>;
  free?: number;
  cache?: boolean;
  jobs?: (base: JobRunner) => JobRunner;
  // a process slot; granted at once by default
  acquire?: (signal: AbortSignal) => Promise<() => void>;
};

function setup(options: Options = {}) {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash,
        created_at)
      values ('u', 'casey', 'Casey Doe', 'casey@example.test', 'admin', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('p1', 'team', 'platform', 'u', 0), ('p2', 'team', 'finops', 'u', 0),
        ('p3', 'team', 'empty', 'u', 0);
    insert into credentials (id, name, key_name, prefix, header, template,
        methods, created_at, updated_at)
      values ('c1', 'github', 'http-github', '${credential.prefix}',
        'authorization', 'Bearer {key}', '["GET"]', 0, 0);
  `);
  const dir = cacheDir();
  dirs.push(dir);
  const host = fakeHost(options.answers ?? {});
  let now = 1_000_000;
  const clock = () => now;
  const logs = collectLogs();
  const limits: RepoLimits = {
    repoBytes: 1_000_000,
    repoFiles: 1_000,
    repoFileBytes: 1_000_000,
    repoCacheBytes: 10_000_000,
    ...options.limits,
  };
  let jobs = 0;
  const base = threadJobs(host.fetch);
  const counted: JobRunner = (job, onEvent, signal) => {
    jobs++;
    return base(job, onEvent, signal);
  };
  const credentials = { current: credential as RepoCredential | null };
  const repos = reposArea({
    db,
    clock,
    access: { project: () => ({ id: "p1", kind: "team" }) },
    projects: { byId: () => null, personal: () => null },
    credentials: {
      byId: (id) =>
        id === credentials.current?.id ? credentials.current : null,
      readKey: () => ({ ok: true, key: "secret-value" }),
      headerValue: (template, key) => template.replace("{key}", key),
    },
    capabilities: { forget() {} },
    cacheDir: options.cache === false ? null : dir,
    jobs: options.jobs ? options.jobs(counted) : counted,
    fetch: host.fetch,
    limits: () => limits,
    log: logs.logFactory("repos"),
    acquire: options.acquire ?? (async () => () => {}),
    userAgent: "1ctx/test",
    freeSpace: () => options.free ?? Number.MAX_SAFE_INTEGER,
  });
  repos.start();
  const add = (projectId: string, fields: Partial<RepoFields> = {}) =>
    repos.store.create(
      projectId,
      {
        name: "widgets",
        url: PAGE,
        kind: "github" as RepoKind,
        ref: "",
        credentialId: null,
        ignore: "",
        ...fields,
      },
      now,
    );
  return {
    db,
    dir,
    repos,
    host,
    logs: logs.events,
    limits,
    credentials,
    add,
    jobs: () => jobs,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const tree = (commit = COMMIT, files = 1) =>
  tarball(
    Array.from({ length: files }, (_, i) => ({ name: `f${i}.go`, body: "x" })),
    { comment: commit },
  );

test("a project with no repositories mounts nothing", async () => {
  const { repos, host } = setup();
  const prepared = await repos.prepare("p3");
  expect(prepared).toMatchObject({ mounts: [], notices: [] });
  prepared.release();
  expect(host.calls).toEqual([]);
});

test("a public repository is looked up through its archive, once a minute", async () => {
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: tarResponse(tree(), '"e1"'),
  };
  const { repos, host, add, tick, logs } = setup({ answers });
  const row = add("p1");
  const first = await repos.prepare("p1");
  expect(first.notices).toEqual([]);
  expect(first.mounts).toEqual([
    expect.objectContaining({
      repoId: row.id,
      name: "widgets",
      url: PAGE,
      commit: COMMIT,
      files: 1,
      bytes: 1,
      missedPin: null,
    }),
  ]);
  expect(readdirSync(first.mounts[0]!.folder)).toEqual(["f0.go"]);
  expect(repos.byId(row.id)).toMatchObject({
    state: "ready",
    error: null,
    commit: COMMIT,
    files: 1,
  });
  expect(logs.map((event) => event.msg)).toEqual(["repo fetched"]);
  expect(JSON.stringify(logs)).not.toContain("git.test/acme");
  first.release();

  // within the minute, no request at all
  await repos.prepare("p1");
  expect(host.calls).toHaveLength(1);

  // past it, the ETag is sent and a 304 mounts the cached tree
  tick(60_001);
  answers[ARCHIVE] = (call) =>
    call.headers["if-none-match"] === '"e1"'
      ? new Response(null, { status: 304 })
      : tarResponse(tree(NEXT_COMMIT));
  const third = await repos.prepare("p1");
  expect(host.calls).toHaveLength(2);
  expect(third.mounts[0]!.commit).toBe(COMMIT);

  // a moved branch is a new folder
  tick(60_001);
  answers[ARCHIVE] = tarResponse(tree(NEXT_COMMIT, 2), '"e2"');
  const fourth = await repos.prepare("p1");
  expect(fourth.mounts[0]).toMatchObject({ commit: NEXT_COMMIT, files: 2 });
  expect(repos.byId(row.id)?.commit).toBe(NEXT_COMMIT);
});

test("a signed repository is looked up through the API and fetched unsigned off its prefix", async () => {
  const answers: Record<string, HostAnswer> = {
    [`${API}commits/main`]: (call) =>
      call.headers["if-none-match"] === '"l1"'
        ? new Response(null, { status: 304 })
        : new Response(COMMIT, { headers: { etag: '"l1"' } }),
    [`${API}tarball/${COMMIT}`]: redirect(`${CODELOAD}/${COMMIT}?token=short`),
    [`${CODELOAD}/${COMMIT}?token=short`]: tarResponse(tree()),
  };
  const { repos, host, add, tick } = setup({ answers });
  add("p1", { ref: "main", credentialId: "c1" });
  const first = await repos.prepare("p1");
  expect(first.mounts[0]?.commit).toBe(COMMIT);
  expect(
    host.calls.map((call) => [call.url, call.headers.authorization ?? null]),
  ).toEqual([
    [`${API}commits/main`, "Bearer secret-value"],
    [`${API}tarball/${COMMIT}`, "Bearer secret-value"],
    [`${CODELOAD}/${COMMIT}?token=short`, null],
  ]);
  expect(host.calls[0]!.headers.accept).toBe("application/vnd.github.sha");

  tick(60_001);
  const second = await repos.prepare("p1");
  expect(second.mounts[0]?.commit).toBe(COMMIT);
  expect(host.calls).toHaveLength(4);
  expect(host.calls[3]!.headers["if-none-match"]).toBe('"l1"');
});

test("a signed and an unsigned lookup of one ref are never shared", async () => {
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: tarResponse(tree()),
    [`${API}commits/HEAD`]: new Response(COMMIT),
  };
  const { repos, host, add } = setup({ answers });
  add("p1", { credentialId: "c1" });
  add("p2");
  await repos.prepare("p1");
  await repos.prepare("p2");
  // the signed one's tarball has no recorded answer, so it fails apart
  expect(host.calls.map((call) => call.url)).toEqual([
    `${API}commits/HEAD`,
    `${API}tarball/${COMMIT}`,
    ARCHIVE,
  ]);
});

test("a failed lookup mounts nothing and says why, logged once", async () => {
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: new Response("gone", { status: 404 }),
  };
  const { repos, add, tick, logs, credentials } = setup({ answers });
  const missing = add("p1");
  const signed = add("p1", { name: "private", credentialId: "c1" });
  credentials.current = null;
  const first = await repos.prepare("p1");
  expect(first.mounts).toEqual([]);
  expect(first.notices).toEqual([
    { repoId: signed.id, name: "private", reason: "no access" },
    { repoId: missing.id, name: "widgets", reason: "not found" },
  ]);
  expect(repos.byId(missing.id)).toMatchObject({
    state: "failed",
    error: "not found",
  });
  tick(60_001);
  await repos.prepare("p1");
  const failures = logs.filter((event) => event.msg === "repo fetch failed");
  expect(failures.map((event) => event.fields)).toEqual([
    { repo_id: signed.id, host: "git.test", reason: "no access" },
    { repo_id: missing.id, host: "git.test", reason: "not found", status: 404 },
  ]);
});

test("a commit ref is looked up too, so a tree fetched signed is never mounted unsigned", async () => {
  const atCommit = `${PAGE}/archive/${COMMIT}.tar.gz`;
  const answers: Record<string, HostAnswer> = {
    [`${API}commits/main`]: new Response(COMMIT),
    [`${API}tarball/${COMMIT}`]: redirect(`${CODELOAD}/${COMMIT}?token=short`),
    [`${CODELOAD}/${COMMIT}?token=short`]: tarResponse(tree()),
    // private: the archive answers no one unsigned
    [atCommit]: new Response("not found", { status: 404 }),
  };
  const { repos, host, add } = setup({ answers });
  add("p1", { ref: "main", credentialId: "c1" });
  expect((await repos.prepare("p1")).mounts[0]?.commit).toBe(COMMIT);
  const other = add("p2", { ref: COMMIT });
  const refused = await repos.prepare("p2");
  expect(refused.mounts).toEqual([]);
  expect(refused.notices).toEqual([
    { repoId: other.id, name: "widgets", reason: "not found" },
  ]);
  expect(host.calls.at(-1)?.url).toBe(atCommit);
});

test("a commit ref is looked up once a minute, a cached one with its ETag", async () => {
  const url = `${PAGE}/archive/${COMMIT}.tar.gz`;
  const { repos, host, add, tick } = setup({
    answers: {
      [url]: (call) =>
        call.headers["if-none-match"] === '"c1"'
          ? new Response(null, { status: 304 })
          : tarResponse(tree(), '"c1"'),
    },
  });
  add("p1", { ref: COMMIT });
  expect((await repos.prepare("p1")).mounts[0]?.commit).toBe(COMMIT);
  expect((await repos.prepare("p1")).mounts[0]?.commit).toBe(COMMIT);
  tick(60_001);
  expect((await repos.prepare("p1")).mounts[0]?.commit).toBe(COMMIT);
  expect(
    host.calls.map((call) => call.headers["if-none-match"] ?? null),
  ).toEqual([null, '"c1"']);
});

test("a turn waits for a cold tree at most its wait, and the fetch goes on", async () => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: async () => {
      await gate;
      return tarResponse(tree());
    },
  };
  const { repos, add, jobs } = setup({ answers });
  const row = add("p1");
  const waiting = await repos.prepare("p1", { waitMs: 20 });
  expect(waiting.notices).toEqual([
    { repoId: row.id, name: "widgets", reason: "fetching" },
  ]);
  // a second turn joins the same fetch
  const joined = repos.prepare("p1", { waitMs: 5_000 });
  open();
  expect((await joined).mounts[0]?.commit).toBe(COMMIT);
  expect(jobs()).toBe(1);
  expect(repos.byId(row.id)?.state).toBe("ready");
});

test("a repository turned off is neither looked up nor mounted", async () => {
  const { repos, host, add } = setup();
  const row = add("p1");
  const prepared = await repos.prepare("p1", { off: new Set([row.id]) });
  expect(prepared).toMatchObject({ mounts: [], notices: [] });
  expect(host.calls).toEqual([]);
});

test("a mounted folder is held until the turn releases it", async () => {
  const answers = { [ARCHIVE]: tarResponse(tree()) };
  const { repos, add, limits, logs } = setup({ answers });
  add("p1");
  const prepared = await repos.prepare("p1");
  const folder = prepared.mounts[0]!.folder;
  limits.repoCacheBytes = 0;
  repos.sweep();
  expect(existsSync(folder)).toBe(true);
  prepared.release();
  repos.sweep();
  expect(existsSync(folder)).toBe(false);
  expect(logs.at(-1)).toMatchObject({
    msg: "repo cache swept",
    fields: { trees: 1, bytes: 1, kept: 0, kept_bytes: 0 },
  });
});

test("a regenerate mounts its commit when cached, else the lookup's with a note", async () => {
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: tarResponse(tree()),
  };
  const { repos, add, tick } = setup({ answers });
  const row = add("p1");
  (await repos.prepare("p1")).release();
  tick(60_001);
  answers[ARCHIVE] = tarResponse(tree(NEXT_COMMIT));
  const pinned = await repos.prepare("p1", {
    pinned: new Map([[row.id, COMMIT]]),
  });
  expect(pinned.mounts[0]).toMatchObject({ commit: COMMIT, missedPin: null });
  const gone = "f".repeat(40);
  const missed = await repos.prepare("p1", {
    pinned: new Map([[row.id, gone]]),
  });
  expect(missed.mounts[0]).toMatchObject({
    commit: NEXT_COMMIT,
    missedPin: gone,
  });
});

test("a tree over the caps fails and is not unpacked again for a while", async () => {
  const atCommit = `${PAGE}/archive/${COMMIT}.tar.gz`;
  const { repos, host, add, tick, jobs } = setup({
    answers: {
      [ARCHIVE]: tarResponse(tree(COMMIT, 3)),
      [atCommit]: tarResponse(tree(COMMIT, 3)),
    },
    limits: { repoFiles: 2 },
  });
  const row = add("p1");
  const prepared = await repos.prepare("p1");
  expect(prepared.notices).toEqual([
    { repoId: row.id, name: "widgets", reason: "over the size cap" },
  ]);
  // the row holds what was counted, for the admin page
  expect(repos.byId(row.id)).toMatchObject({
    state: "failed",
    error: "over the size cap",
    files: 3,
    bytes: 3,
  });
  // within the minute nothing is asked; past it the lookup stops at
  // the commit, and the tree by commit is never fetched
  await repos.prepare("p1");
  tick(60_001);
  const later = await repos.prepare("p1");
  expect(later.notices.map((notice) => notice.reason)).toEqual([
    "over the size cap",
  ]);
  expect(host.calls.map((call) => call.url)).toEqual([ARCHIVE, ARCHIVE]);
  expect(jobs()).toBe(2);
});

test("a full cache volume refuses the fetch", async () => {
  const { repos, add, host, dir } = setup({
    answers: { [ARCHIVE]: tarResponse(tree()) },
    free: 0,
  });
  const row = add("p1");
  const prepared = await repos.prepare("p1");
  expect(prepared.notices).toEqual([
    { repoId: row.id, name: "widgets", reason: "cache full" },
  ]);
  // the lookup went out; the unpack was refused
  expect(host.calls).toHaveLength(1);
  expect(readdirSync(join(dir, "trees"))).toEqual([]);
});

test("a cached tree mounts while other fetches hold every slot", async () => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slow = async () => {
    await gate;
    return tarResponse(tree());
  };
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: (call) =>
      call.headers["if-none-match"]
        ? new Response(null, { status: 304 })
        : tarResponse(tree(), '"e1"'),
    "https://git.test/acme/one/archive/HEAD.tar.gz": slow,
    "https://git.test/acme/two/archive/HEAD.tar.gz": slow,
  };
  // the process slots are held by commands: none is granted
  let granted = true;
  const { repos, add, tick } = setup({
    answers,
    acquire: (signal) =>
      granted
        ? Promise.resolve(() => {})
        : new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
  });
  add("p1");
  (await repos.prepare("p1")).release();
  granted = false;
  add("p2", { name: "one", url: "https://git.test/acme/one" });
  add("p3", { name: "two", url: "https://git.test/acme/two" });
  const cold = repos.prepare("p2", { waitMs: 20 });
  const colder = repos.prepare("p3", { waitMs: 20 });
  tick(60_001);
  const cached = await repos.prepare("p1", { waitMs: 200 });
  expect(cached.mounts.map((mount) => mount.commit)).toEqual([COMMIT]);
  open();
  // a cold tree past its wait: the turn goes on, never stuck on a slot
  expect((await cold).notices.map((notice) => notice.reason)).toEqual([
    "fetching",
  ]);
  expect((await colder).notices.map((notice) => notice.reason)).toEqual([
    "fetching",
  ]);
  repos.close();
});

test("without a cache directory nothing is fetched and no row changes", async () => {
  const { repos, add, host } = setup({ cache: false });
  const row = add("p1");
  const prepared = await repos.prepare("p1");
  expect(prepared.notices).toEqual([
    { repoId: row.id, name: "widgets", reason: "cache full" },
  ]);
  expect(repos.byId(row.id)?.state).toBe("pending");
  expect(host.calls).toEqual([]);
  expect(repos.start()).toBeNull();
});

test("startup sets a fetching row pending, clears tmp/ and fetches what waits", async () => {
  const { repos, add, dir } = setup({
    answers: { [ARCHIVE]: tarResponse(tree()) },
  });
  const row = add("p1");
  const waiting = add("p2");
  repos.store.setFetched(row.id, { state: "fetching", error: null });
  repos.start();
  expect(repos.byId(row.id)?.state).toBe("pending");
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  for (let i = 0; i < 200; i++) {
    if ([row, waiting].every((r) => repos.byId(r.id)?.state === "ready")) break;
    await Bun.sleep(5);
  }
  expect(repos.byId(row.id)?.state).toBe("ready");
  expect(repos.byId(waiting.id)?.state).toBe("ready");
});

test("the drain ends every fetch and writes no row after", async () => {
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: (_call, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  };
  const { repos, add } = setup({ answers });
  const row = add("p1");
  const turn = repos.prepare("p1", { waitMs: 5_000 });
  await Bun.sleep(5);
  repos.close();
  expect((await turn).notices).toEqual([
    { repoId: row.id, name: "widgets", reason: "host unreachable" },
  ]);
  expect(repos.byId(row.id)?.state).toBe("pending");
});

test("a job that ends while it waits for its slots gives them back, unremembered", async () => {
  const five = "https://git.test/acme/five";
  let held = 0;
  let grant = () => {};
  const granted = new Promise<void>((resolve) => {
    grant = resolve;
  });
  let late = true;
  // a process slot granted only after the job ended
  const acquire = async () => {
    if (late) await granted;
    held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held--;
    };
  };
  let stuck = 0;
  const { repos, add } = setup({
    answers: { [`${five}/archive/HEAD.tar.gz`]: tarResponse(tree()) },
    acquire,
    jobs: (base) => (job, onEvent, signal) => {
      if (!job.url.includes("/stuck")) return base(job, onEvent, signal);
      stuck++;
      // like the worker at its deadline: ended, never waiting on the go
      void onEvent({ commit: COMMIT, etag: null, published: false });
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: "host unreachable", status: null }),
          20,
        ),
      );
    },
  });
  add("p1", { name: "one", url: "https://git.test/acme/stuck1" });
  add("p2", { name: "two", url: "https://git.test/acme/stuck2" });
  await repos.prepare("p1", { waitMs: 200 });
  await repos.prepare("p2", { waitMs: 200 });
  late = false;
  grant();
  await Bun.sleep(10);
  expect(held).toBe(0);
  // both fetch slots came back too
  add("p3", { name: "five", url: five });
  const fresh = await repos.prepare("p3", { waitMs: 1_000 });
  expect(fresh.mounts.map((mount) => mount.name)).toEqual(["five"]);
  expect(held).toBe(0);
  // a death in the queue says nothing of the host: tried again at once
  const before = stuck;
  await repos.prepare("p1", { waitMs: 200 });
  expect(stuck).toBe(before + 1);
});

test("a failure of one signer's is never another's", async () => {
  const atCommit = `${PAGE}/archive/${COMMIT}.tar.gz`;
  const answers: Record<string, HostAnswer> = {
    [`${API}commits/main`]: new Response(COMMIT),
    [`${API}tarball/${COMMIT}`]: new Response("no", { status: 403 }),
    [atCommit]: tarResponse(tree()),
  };
  const { repos, add } = setup({ answers });
  add("p1", { ref: "main", credentialId: "c1" });
  expect((await repos.prepare("p1")).notices[0]?.reason).toBe("no access");
  add("p2", { ref: COMMIT });
  expect((await repos.prepare("p2")).mounts[0]?.commit).toBe(COMMIT);
});
