// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ignoreKey } from "../../../src/server/repos/rules.ts";
import {
  type FetchJob,
  type JobEvent,
  type JobResult,
  runJob,
  treeFolder,
} from "../../../src/server/repos/unpack.ts";
import {
  COMMIT,
  COMMIT_TIME,
  cacheDir,
  fakeHost,
  NEXT_COMMIT,
  type TarEntry,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";

const URL = "https://git.test/acme/widgets/archive/HEAD.tar.gz";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function job(over: Partial<FetchJob> = {}): FetchJob {
  const dir = cacheDir();
  dirs.push(dir);
  return {
    id: "job1",
    url: URL,
    etag: null,
    header: null,
    expect: null,
    ignore: "",
    ignoreKey: ignoreKey(over.ignore ?? ""),
    source: "s1",
    cacheDir: dir,
    caps: { bytes: 1_000_000, files: 100, fileBytes: 1_000 },
    deadlineMs: 10_000,
    stallMs: 5_000,
    userAgent: "1ctx/test",
    ...over,
  };
}

async function run(
  entries: TarEntry[] | Uint8Array | Response,
  over: Partial<FetchJob> = {},
): Promise<{
  result: JobResult;
  events: JobEvent[];
  job: FetchJob;
  files: string;
}> {
  const fixture = job(over);
  const response =
    entries instanceof Response
      ? entries
      : tarResponse(entries instanceof Uint8Array ? entries : tarball(entries));
  const host = fakeHost({ [fixture.url]: response });
  const events: JobEvent[] = [];
  const result = await runJob(fixture, {
    fetch: host.fetch,
    emit: (event) => events.push(event),
  });
  const commit = result.ok && result.kind === "tree" ? result.commit : COMMIT;
  const folder = treeFolder(fixture.cacheDir, "s1", commit, fixture.ignoreKey);
  return { result, events, job: fixture, files: join(folder, "files") };
}

const leftovers = (fixture: FetchJob) =>
  existsSync(join(fixture.cacheDir, "tmp"))
    ? readdirSync(join(fixture.cacheDir, "tmp"))
    : [];

test("a tarball is unpacked under its commit with modes and the commit's time", async () => {
  const {
    result,
    events,
    job: fixture,
    files,
  } = await run([
    { name: "src", type: "dir" },
    { name: "src/main.go", body: "package main\n", mode: 0o644 },
    { name: "src/run.sh", body: "echo\n", mode: 0o755 },
    { name: "locked", body: "x", mode: 0o000 },
    { name: "docs/deep/nested/README.md", body: "# hi\n" },
  ]);
  expect(events).toEqual([{ commit: COMMIT, etag: '"t1"' }]);
  expect(result).toMatchObject({
    ok: true,
    kind: "tree",
    commit: COMMIT,
    etag: '"t1"',
    fetched: true,
    meta: {
      commit: COMMIT,
      time: COMMIT_TIME,
      files: 4,
      bytes: 13 + 5 + 1 + 5,
      large: 0,
      ignored: 0,
      dropped: 0,
    },
  });
  expect(readFileSync(join(files, "src/main.go"), "utf8")).toBe(
    "package main\n",
  );
  expect(statSync(join(files, "src/main.go")).mode & 0o777).toBe(0o644);
  expect(statSync(join(files, "src/run.sh")).mode & 0o777).toBe(0o755);
  expect(statSync(join(files, "locked")).mode & 0o777).toBe(0o400);
  for (const path of [
    "src/main.go",
    "docs/deep/nested/README.md",
    "docs",
    "src",
  ]) {
    expect(Math.floor(statSync(join(files, path)).mtimeMs / 1000)).toBe(
      COMMIT_TIME,
    );
  }
  const meta = JSON.parse(readFileSync(join(files, "..", "tree.json"), "utf8"));
  expect(meta.commit).toBe(COMMIT);
  expect(leftovers(fixture)).toEqual([]);
});

test("a link inside the tree is kept, one out of it and odd members are dropped", async () => {
  const { result, files } = await run([
    { name: "charts/values.yaml", body: "a: 1\n" },
    { name: "charts/link.yaml", type: "symlink", linkname: "values.yaml" },
    {
      name: "up.yaml",
      type: "symlink",
      linkname: "charts/../charts/values.yaml",
    },
    { name: "out", type: "symlink", linkname: "../../etc/passwd" },
    { name: "abs", type: "symlink", linkname: "/etc/passwd" },
    { name: "self", type: "symlink", linkname: "." },
    { name: "copy.yaml", type: "link", linkname: "charts/values.yaml" },
    { name: "nothing", type: "link", linkname: "missing.yaml" },
    { name: "pipe", type: "fifo" },
  ]);
  expect(result).toMatchObject({
    ok: true,
    meta: { files: 2, bytes: 10, dropped: 5 },
  });
  expect(readlinkSync(join(files, "charts/link.yaml"))).toBe("values.yaml");
  expect(lstatSync(join(files, "up.yaml")).isSymbolicLink()).toBe(true);
  for (const name of ["out", "abs", "self", "nothing", "pipe"]) {
    expect(existsSync(join(files, name))).toBe(false);
  }
  expect(lstatSync(join(files, "copy.yaml")).isFile()).toBe(true);
  expect(readFileSync(join(files, "copy.yaml"), "utf8")).toBe("a: 1\n");
});

test("a bad name or a duplicate fails the fetch and leaves nothing", async () => {
  const cases: TarEntry[][] = [
    [{ name: "../escape", body: "x" }],
    [{ name: "/abs/file", body: "x" }],
    [{ name: "a\\b", body: "x" }],
    [{ name: "ctl\u0001", body: "x" }],
    [{ name: "a//b", body: "x" }],
    [
      { name: "dup", body: "x" },
      { name: "dup", body: "y" },
    ],
    [
      { name: "file", body: "x" },
      { name: "file/under", body: "y" },
    ],
    [
      { name: "link", type: "symlink", linkname: "dir" },
      { name: "dir", type: "dir" },
      { name: "link/under", body: "y" },
    ],
  ];
  for (const entries of cases) {
    const { result, job: fixture, files } = await run(entries);
    expect(result).toEqual({
      ok: false,
      error: "host unreachable",
      status: 200,
    });
    expect(existsSync(files)).toBe(false);
    expect(leftovers(fixture)).toEqual([]);
  }
});

test("a name past 100 bytes comes whole", async () => {
  const long = `${"deep/".repeat(30)}file.txt`;
  const { result, files } = await run([{ name: long, body: "x" }]);
  expect(result).toMatchObject({ ok: true, meta: { files: 1 } });
  expect(readFileSync(join(files, long), "utf8")).toBe("x");
});

test("a file past the file cap is kept and counted", async () => {
  const { result, files } = await run([{ name: "big.bin", size: 2_000 }]);
  expect(result).toMatchObject({ ok: true, meta: { files: 1, large: 1 } });
  expect(statSync(join(files, "big.bin")).size).toBe(2_000);
});

test("a tree past its caps fails over the size cap", async () => {
  const many = (n: number, ext = "txt") =>
    Array.from({ length: n }, (_, i) => ({ name: `f${i}.${ext}`, body: "x" }));
  const caps = { bytes: 1_000, files: 5, fileBytes: 1_000 };
  const over: [TarEntry[], { files: number; bytes: number }][] = [
    // past a cap the rest is still counted, for the admin's numbers
    [many(8), { files: 8, bytes: 8 }],
    [
      [
        { name: "a", size: 600 },
        { name: "b", size: 600 },
      ],
      { files: 2, bytes: 1_200 },
    ],
    // ignored members count toward four times the files
    [many(21, "png"), { files: 0, bytes: 0 }],
  ];
  for (const [entries, seen] of over) {
    const { result, job: fixture, files } = await run(entries, { caps });
    expect(result).toEqual({
      ok: false,
      error: "over the size cap",
      status: 200,
      seen,
    });
    expect(existsSync(files)).toBe(false);
    expect(leftovers(fixture)).toEqual([]);
  }
  // compressed bytes past four times the tree's cap
  const noise = crypto.getRandomValues(new Uint8Array(5_000));
  const { result } = await run([{ name: "noise", body: noise }], {
    caps: { bytes: 1_000, files: 5, fileBytes: 10_000 },
    ignore: "noise\n",
  });
  expect(result).toEqual({
    ok: false,
    error: "over the size cap",
    status: 200,
    seen: { files: 0, bytes: 0 },
  });
});

test("the ignore rules apply while unpacking, by path and parent", async () => {
  const entries: TarEntry[] = [
    { name: "logo.png", body: "x" },
    { name: "src/app.ts", body: "x" },
    { name: "charts", type: "dir" },
    { name: "charts/app/values.yaml", body: "x" },
    { name: "vendor", type: "dir" },
    { name: "vendor/keep.go", body: "x" },
  ];
  const defaults = await run(entries);
  expect(defaults.result).toMatchObject({
    ok: true,
    meta: { files: 3, ignored: 1 },
  });
  expect(existsSync(join(defaults.files, "logo.png"))).toBe(false);

  const own = await run(entries, {
    ignore: "/*\n!/charts/\nvendor/\n!vendor/keep.go\n",
  });
  expect(own.result).toMatchObject({
    ok: true,
    meta: { files: 1, ignored: 3 },
  });
  expect(readdirSync(own.files)).toEqual(["charts"]);
  expect(existsSync(join(own.files, "charts/app/values.yaml"))).toBe(true);
});

test("the commit comes from the first member's pax comment", async () => {
  const none = await run(
    tarball([{ name: "a", body: "x" }], { comment: null }),
  );
  expect(none.result).toEqual({ ok: false, error: "no commit", status: 200 });
  expect(none.events).toEqual([]);

  const expected = await run(
    tarball([{ name: "a", body: "x" }], { comment: null }),
    {
      expect: NEXT_COMMIT,
    },
  );
  expect(expected.result).toMatchObject({ ok: true, commit: NEXT_COMMIT });

  const other = await run([{ name: "a", body: "x" }], { expect: NEXT_COMMIT });
  expect(other.result).toEqual({ ok: false, error: "not found", status: 200 });

  const bad = await run(
    tarball([{ name: "a", body: "x" }], { comment: "main" }),
  );
  expect(bad.result).toEqual({
    ok: false,
    error: "host unreachable",
    status: 200,
  });

  const plain = await run(tarball([{ name: "a", body: "x" }], { gzip: false }));
  expect(plain.result).toMatchObject({ ok: true, commit: COMMIT });
});

test("a commit already published stops the read", async () => {
  const first = await run([{ name: "a", body: "x" }]);
  const fixture = { ...first.job, id: "job2" };
  const host = fakeHost({
    [URL]: tarResponse(tarball([{ name: "b", body: "y" }])),
  });
  const result = await runJob(fixture, { fetch: host.fetch, emit() {} });
  expect(result).toMatchObject({
    ok: true,
    fetched: false,
    meta: { files: 1 },
  });
  expect(readdirSync(first.files)).toEqual(["a"]);
});

test("a job that loses the publish to a concurrent one removes its own", async () => {
  const fixture = job();
  const tar = tarball([{ name: "a", body: "x" }], { gzip: false });
  const target = treeFolder(fixture.cacheDir, "s1", COMMIT, fixture.ignoreKey);
  let named = () => {};
  const commitNamed = new Promise<void>((resolve) => {
    named = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(tar.subarray(0, 1536));
    },
    async pull(controller) {
      await commitNamed;
      // the other job renames its tree in while this one unpacks
      mkdirSync(join(target, "files"), { recursive: true });
      writeFileSync(
        join(target, "tree.json"),
        JSON.stringify({
          commit: COMMIT,
          time: 1,
          files: 7,
          bytes: 7,
          large: 0,
          ignored: 0,
          dropped: 0,
        }),
      );
      controller.enqueue(tar.subarray(1536));
      controller.close();
    },
  });
  const host = fakeHost({ [URL]: () => new Response(body) });
  const result = await runJob(fixture, { fetch: host.fetch, emit: named });
  expect(result).toMatchObject({
    ok: true,
    fetched: false,
    meta: { files: 7 },
  });
  expect(leftovers(fixture)).toEqual([]);
});

test("a host's answer maps to a closed word, a 304 to unchanged", async () => {
  const unchanged = await run(new Response(null, { status: 304 }), {
    etag: '"t1"',
  });
  expect(unchanged.result).toEqual({ ok: true, kind: "unchanged" });
  expect(unchanged.events).toEqual([{ commit: null, etag: '"t1"' }]);
  for (const [status, error] of [
    [404, "not found"],
    [401, "no access"],
    [403, "no access"],
    [500, "host unreachable"],
    [304, "host unreachable"],
  ] as const) {
    const { result } = await run(new Response("nope", { status }));
    expect(result).toEqual({ ok: false, error, status });
  }
  const host = fakeHost({});
  const result = await runJob(job(), { fetch: host.fetch, emit() {} });
  expect(result).toEqual({
    ok: false,
    error: "host unreachable",
    status: null,
  });
});

test("a body that stalls or runs past the deadline fails", async () => {
  const silent = () =>
    new Response(
      new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }),
    );
  const stalled = await run(silent(), { stallMs: 30 });
  expect(stalled.result).toMatchObject({
    ok: false,
    error: "host unreachable",
  });
  const late = await run(silent(), { deadlineMs: 30 });
  expect(late.result).toMatchObject({ ok: false, error: "host unreachable" });
  expect(leftovers(late.job)).toEqual([]);
});
