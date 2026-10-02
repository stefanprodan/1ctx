// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what git answers for each ignore text over one tree, into
// test/fixtures/repos/ignore-cases.json: `bun scripts/ignore-record.ts`
// with git on the PATH. Run by hand; the suite reads the fixture.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REPO_IGNORE as DEFAULT_IGNORE } from "../src/shared/contracts/repo.ts";

const OUT = new URL("../test/fixtures/repos/ignore-cases.json", import.meta.url)
  .pathname;

// folders end in a slash
const TREE = [
  ".github/workflows/ci.yml",
  ".gitlab-ci.yml",
  "README.md",
  "build/out.o",
  "build/keep.txt",
  "build/sub/deep.o",
  "src/build",
  "src/main.go",
  "src/main_test.go",
  "src/lib/util.go",
  "src/lib/build/gen.go",
  "docs/a.md",
  "docs/img/logo.png",
  "docs/img/Shot.PNG",
  "docs/img/pic.jpg",
  "doc",
  "charts/app/Chart.yaml",
  "charts/app/templates/deploy.yaml",
  "other/x.yaml",
  "foo/bar/baz.txt",
  "foobar/x",
  "foo2/bar",
  "fooa/b/bar",
  "foobar.txt",
  "a/b/c/d/e.txt",
  "a/x/b/f.txt",
  "a/b/e.txt",
  "a/c",
  "#hash.txt",
  "!bang.txt",
  "trail ",
  "trail",
  "sp ace.txt",
  "[ab].txt",
  "a.txt",
  "b.txt",
  "c.txt",
  "Z.txt",
  "7.txt",
  "-.txt",
  "].txt",
  "^.txt",
  "!.txt",
  "star*.txt",
  "starx.txt",
  "q?.txt",
  "qx.txt",
  "back\\slash.txt",
  "ü.txt",
  "é/ndir/x.txt",
  "日本.md",
  "vendor/pkg/a.go",
  "node_modules/x/index.js",
  "sub/node_modules/y.js",
  "media/a.jpeg",
  "media/c.gif",
  "media/d.ico",
  "media/e.webp",
  "media/v.mp4",
  "media/m.mov",
  "media/s.mp3",
  "fonts/f.woff",
  "fonts/g.woff2",
  "fonts/h.ttf",
  "dist/z.zip",
  "dist/t.tar.gz",
  "dist/t.tgz",
  "dist/j.jar",
  "dist/x.gz",
  "dist/png",
  "dist/dir.png/inner.txt",
  "empty/",
  "deep/empty/",
];

const CASES: Record<string, string> = {
  "default list": `${DEFAULT_IGNORE.join("\n")}\n`,
  "folder only": "build/\n",
  "file or folder": "build\n",
  anchored: "/build\n",
  "anchored folder": "/build/\n",
  "anchored by a middle slash": "src/build\n",
  "middle slash folder only": "src/build/\n",
  "nested name anywhere": "build/\n!build/keep.txt\n",
  "negation of a file": "*.go\n!*_test.go\n",
  "one folder mounted": "/*\n!/charts/\n",
  "one nested folder mounted": "/*\n!/charts/\n/charts/*\n!/charts/app/\n",
  "negation under an ignored folder": "charts/\n!charts/app/Chart.yaml\n",
  "negation of the folder's contents": "charts/*\n!charts/app/\n",
  "leading double star": "**/build\n",
  "leading double star folder": "**/node_modules/\n",
  "middle double star": "a/**/e.txt\n",
  "middle double star zero folders": "a/**/b\n",
  "two middle double stars": "a/**/b/**/e.txt\n",
  "trailing double star": "a/**\n",
  "trailing double star with negation": "a/**\n!a/b/e.txt\n",
  "inner double star": "**/c/**\n",
  "double star alone": "**\n",
  "anchored double star": "/**\n",
  "triple star": "***/e.txt\n",
  "double star as a star": "a**t\n",
  "double star after a name": "foo**/bar\n",
  "double star after a slash name": "foo/b**\n",
  "anchored double star after a name": "/foo**\n",
  "double star extension": "**.txt\n",
  "double star mid name in a path": "a/b**/e.txt\n",
  "star everything": "*\n",
  "star folders only": "*/\n",
  "star in the middle": "a/*/e.txt\n",
  "star not across slashes": "a/*.txt\n",
  "star then slash": "*/x.txt\n",
  "star twice": "f*o*r\n",
  "question mark": "?.txt\n",
  "two question marks": "??.txt\n",
  "question mark not a slash": "a?c\n",
  class: "[ab].txt\n",
  "negated class with bang": "[!ab].txt\n",
  "negated class with caret": "[^ab].txt\n",
  range: "[a-c].txt\n",
  "range and literal dash": "[a-].txt\n",
  "dash first": "[-a].txt\n",
  "bracket first": "[]].txt\n",
  "escaped bracket": "[\\]].txt\n",
  "posix class alpha": "[[:alpha:]].txt\n",
  "posix classes": "[[:digit:][:upper:]].txt\n",
  "posix class punct": "[[:punct:]].txt\n",
  "not a posix class": "[[:a].txt\n",
  "slash in a class": "a[/]c\n",
  "literal brackets": "\\[ab\\].txt\n",
  "escaped hash": "\\#hash.txt\n",
  "hash comment": "#hash.txt\n",
  "escaped bang": "\\!bang.txt\n",
  "bang alone": "!\n",
  "escaped star": "star\\*.txt\n",
  "escaped question mark": "q\\?.txt\n",
  "escaped backslash": "back\\\\slash.txt\n",
  "escaped letter": "\\a.txt\n",
  "trailing spaces dropped": "README.md   \ntrail \n",
  "escaped trailing space": "trail\\ \n",
  "inner space": "sp ace.txt\n",
  "crlf lines": "build/\r\n*.md\r\n",
  "blank and space lines": "\n   \n\t\nbuild\n",
  "no final newline": "*.md",
  "case sensitive": "*.png\n",
  "upper case": "*.PNG\n",
  "prefix is not a match": "doc\n",
  dotfiles: ".*\n",
  "dot folder": ".github/\n",
  "nested path": "a/b\n",
  "anchored nested folder": "/a/b/\n",
  "double slash": "a//b\n",
  "root slash": "/\n",
  "non ascii name": "ü.txt\n",
  "non ascii folder": "é/\n",
  "non ascii glob": "*.md\n!日本.md\n",
  "file under folder pattern": "dist/*.png\n",
  "folder named like a file": "*.png/\n",
  "re-ignore after negation": "*.txt\n!a.txt\na.*\n",
  "empty folders": "empty/\n",
  "flux style": "/*\n!/charts/\n!/src/\n/src/**/build/\n*.yaml\n!Chart.yaml\n",
  "escaped slash": "a\\/b\n",
  "double star before an escaped slash": "**\\/e.txt\n",
  "double star after a literal folder": "foo/**/baz.txt\n",
  "star before a class": "*[0-9].txt\n",
  "star then question mark": "a/*?\n",
  "folder then star": "src/*\n!src/lib/\n",
  "negated folder then file": "build/\n!build/\n",
};

const git = (
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
) => {
  const run = Bun.spawnSync(
    [
      "git",
      "-c",
      "core.ignorecase=false",
      "-c",
      "core.precomposeunicode=false",
      ...args,
    ],
    {
      cwd,
      env,
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return run;
};

const version = Bun.spawnSync(["git", "--version"], { stdout: "pipe" })
  .stdout.toString()
  .trim();
const home = await mkdtemp(join(tmpdir(), "ignore-home-"));
const dir = await mkdtemp(join(tmpdir(), "ignore-tree-"));
try {
  // no global or system config, so no excludes file but ours
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const init = git(["init", "-q", "."], dir, env);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  await writeFile(join(dir, ".git", "info", "exclude"), "");
  const paths: { path: string; dir: boolean }[] = [];
  const seen = new Set<string>();
  const add = (path: string, isDir: boolean) => {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push({ path, dir: isDir });
  };
  for (const entry of TREE) {
    const isDir = entry.endsWith("/");
    const path = isDir ? entry.slice(0, -1) : entry;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      add(parts.slice(0, i).join("/"), true);
    }
    add(path, isDir);
    if (isDir) await mkdir(join(dir, path), { recursive: true });
    else {
      await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(dir, path), "x\n");
    }
  }
  const input = `${paths.map((p) => p.path).join("\0")}\0`;
  const cases = [];
  for (const [name, ignore] of Object.entries(CASES)) {
    await writeFile(join(dir, ".gitignore"), ignore);
    const run = git(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      dir,
      env,
      input,
    );
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      throw new Error(`${name}: ${run.stderr.toString()}`);
    }
    const out = run.stdout
      .toString()
      .split("\0")
      .filter((p) => p !== "");
    cases.push({ name, ignore, ignored: out.sort() });
  }
  await writeFile(
    OUT,
    `${JSON.stringify({ git: version, tree: paths, cases }, null, 2)}\n`,
  );
  console.log(
    `${cases.length} texts over ${paths.length} paths with ${version}`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
