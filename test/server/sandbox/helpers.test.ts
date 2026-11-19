// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The helpers run for real with the host's python3 and bash, against
// folders the test makes. The fence is never run here: it stops and
// kills every process of its uid, the test runner's too. Its builtins-
// only rule is checked on its source, and it runs against a real
// gateway in the hand-run sandbox script.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePush, escapePath } from "../../../src/server/sandbox/frames.ts";
import {
  fenceArgv,
  HELPER_SOURCES,
  pullArgv,
  pushArgv,
  RECORDS_EXIST,
  recordPaths,
  startTimeOf,
  walkArgv,
  wrapperArgv,
} from "../../../src/server/sandbox/helpers.ts";
import { decodePull, pullRequest } from "../../../src/server/sandbox/pull.ts";
import { decodeWalk } from "../../../src/server/sandbox/walk.ts";

const using = {
  python: Bun.which("python3") ?? "python3",
  bash: Bun.which("bash") ?? "bash",
};
const WIDE = { entries: 1000, nameBytes: 100_000, fileBytes: 10_000_000 };
// a command id as the server makes them, 22 characters at least
const idOf = (name: string) => `${name}-`.padEnd(22, "0");
const LIMITS = { entries: 1000, fileBytes: 10_000_000, totalBytes: 10_000_000 };

function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "1ctx-shell-")));
  const roots = [join(base, "knowledge"), join(base, "tmp")];
  for (const root of roots) mkdirSync(root);
  return { base, roots };
}

async function run(argv: string[], stdin?: Uint8Array, env = {}) {
  const proc = Bun.spawn(argv, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, text: new TextDecoder().decode(stdout), stderr, code };
}

const push = (roots: string[], chunk: Uint8Array) =>
  run(pushArgv(roots, using), chunk);
const frame = (fields: Record<string, unknown>, data = "") =>
  new TextEncoder().encode(`${JSON.stringify(fields)}\n${data}`);

describe("push helper", () => {
  test("apply every op, a large file in appended parts", async () => {
    const { roots } = scratch();
    const [docs, tmp] = roots as [string, string];
    mkdirSync(join(tmp, "empty"));
    writeFileSync(join(tmp, "old"), "old");
    symlinkSync("/etc/hosts", join(tmp, "link"));
    writeFileSync(join(docs, "kept.md"), "kept");
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => i % 253);
    const chunks = encodePush(
      {
        remove: [join(tmp, "empty"), join(tmp, "old"), join(tmp, "link")],
        folders: [{ path: join(tmp, "a b"), mode: 0o750, mtime: 1_600_000 }],
        files: [
          {
            path: join(tmp, "a b", "big"),
            mode: 0o440,
            mtime: 1_700_000,
            data: big,
          },
          {
            path: join(docs, "néw\nline.md"),
            mode: 0o644,
            mtime: 1_800_000,
            data: new TextEncoder().encode("hi"),
          },
        ],
        meta: [{ path: join(docs, "kept.md"), mode: 0o600, mtime: 1_900_000 }],
      },
      { roots, limit: 64 * 1024 },
    );
    expect(chunks.length).toBeGreaterThan(4);
    let frames = 0;
    for (const chunk of chunks) {
      const result = await push(roots, chunk);
      expect(result.code).toBe(0);
      frames += Number(/^PUSH ok (\d+)$/.exec(result.text.trim())![1]);
    }
    expect(frames).toBeGreaterThan(chunks.length);
    for (const gone of ["empty", "old", "link"])
      expect(existsSync(join(tmp, gone))).toBe(false);
    const file = statSync(join(tmp, "a b", "big"));
    expect(new Uint8Array(readFileSync(join(tmp, "a b", "big")))).toEqual(big);
    expect(file.mode & 0o7777).toBe(0o440);
    expect(file.mtimeMs).toBe(1_700_000);
    const folder = statSync(join(tmp, "a b"));
    expect([folder.mode & 0o7777, folder.mtimeMs]).toEqual([0o750, 1_600_000]);
    expect(readFileSync(join(docs, "néw\nline.md"), "utf8")).toBe("hi");
    const kept = statSync(join(docs, "kept.md"));
    expect([kept.mode & 0o7777, kept.mtimeMs]).toEqual([0o600, 1_900_000]);
  });

  test("replace a link standing at a file's path, never writing through it", async () => {
    const { base, roots } = scratch();
    writeFileSync(join(base, "outside"), "outside");
    symlinkSync(join(base, "outside"), join(roots[1]!, "f"));
    const [chunk] = encodePush(
      {
        files: [
          {
            path: join(roots[1]!, "f"),
            mode: 0o644,
            mtime: 0,
            data: new TextEncoder().encode("in"),
          },
        ],
      },
      { roots },
    );
    expect((await push(roots, chunk!)).code).toBe(0);
    expect(lstatSync(join(roots[1]!, "f")).isFile()).toBe(true);
    expect(readFileSync(join(base, "outside"), "utf8")).toBe("outside");
  });

  test("refuse what it must never write", async () => {
    const { base, roots } = scratch();
    const tmp = roots[1]!;
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(tmp, "door"));
    mkdirSync(join(tmp, "full"));
    writeFileSync(join(tmp, "full", "f"), "");
    const file = (path: string) => ({
      op: "file",
      path: escapePath(path),
      mode: 0o644,
      mtime: 0,
      size: 1,
    });
    const cases: [Uint8Array, string][] = [
      [frame(file(`${tmp}/../x`), "x"), "PUSH refused name"],
      [frame(file(`${tmp}//x`), "x"), "PUSH refused name"],
      [frame(file(join(base, "x")), "x"), "PUSH refused outside"],
      [frame(file(join(tmp, "door", "x")), "x"), "PUSH refused link"],
      [
        frame({ op: "rm", path: escapePath(join(tmp, "full")) }),
        "PUSH refused notempty",
      ],
      [frame({ op: "rm", path: escapePath(tmp) }), "PUSH refused root"],
      [
        frame({ op: "meta", path: escapePath(tmp), mode: 0o755, mtime: 0 }),
        "PUSH refused root",
      ],
      [
        frame({ op: "dir", path: escapePath(tmp), mode: 0o755, mtime: 0 }),
        "PUSH refused root",
      ],
      [
        frame({ ...file(join(tmp, "f")), mtime: 10 ** 20 }, "x"),
        "PUSH refused header",
      ],
      [frame(file(join(tmp, "short"))), "PUSH refused short"],
      [
        frame({ ...file(join(tmp, "f")), path: "/tmp/a b" }, "x"),
        "PUSH refused name",
      ],
      [
        frame({ ...file(join(tmp, "f")), mode: "644" }, "x"),
        "PUSH refused header",
      ],
      [
        frame({ ...file(join(tmp, "f")), op: "link" }, "x"),
        "PUSH refused header",
      ],
      [
        frame({
          op: "meta",
          path: escapePath(join(tmp, "none")),
          mode: 0,
          mtime: 0,
        }),
        "PUSH refused missing",
      ],
      [
        frame({ ...file(join(tmp, "none")), append: true }, "x"),
        "PUSH refused missing",
      ],
    ];
    for (const [stdin, words] of cases) {
      const result = await push(roots, stdin);
      expect(result.code).toBe(2);
      expect(result.text.startsWith(words)).toBe(true);
    }
    expect(existsSync(join(base, "elsewhere", "x"))).toBe(false);
    expect(existsSync(join(base, "x"))).toBe(false);
  });

  test("change a read-only folder, then give it back its mode", async () => {
    const { roots } = scratch();
    const tmp = roots[1]!;
    const shut = join(tmp, "shut");
    mkdirSync(shut);
    writeFileSync(join(shut, "old"), "old");
    chmodSync(shut, 0o555);
    const chunks = encodePush(
      {
        remove: [join(shut, "old")],
        files: [
          {
            path: join(shut, "new"),
            mode: 0o644,
            mtime: 5,
            data: new TextEncoder().encode("new"),
          },
        ],
        meta: [{ path: shut, mode: 0o555, mtime: 6 }],
      },
      { roots },
    );
    for (const chunk of chunks) {
      const result = await push(roots, chunk);
      expect(result.text).toStartWith("PUSH ok");
    }
    expect(existsSync(join(shut, "old"))).toBe(false);
    expect(readFileSync(join(shut, "new"), "utf8")).toBe("new");
    const folder = statSync(shut);
    expect([folder.mode & 0o7777, folder.mtimeMs]).toEqual([0o555, 6]);
    chmodSync(shut, 0o755);
  });

  test("refuse a mode on a hard-linked file, which would reach its other name", async () => {
    const { base, roots } = scratch();
    writeFileSync(join(base, "secret"), "s");
    chmodSync(join(base, "secret"), 0o600);
    linkSync(join(base, "secret"), join(roots[1]!, "h"));
    const result = await push(
      roots,
      frame({
        op: "meta",
        path: escapePath(join(roots[1]!, "h")),
        mode: 0o777,
        mtime: 0,
      }),
    );
    expect(result.text).toStartWith("PUSH refused kind");
    expect(statSync(join(base, "secret")).mode & 0o777).toBe(0o600);
  });
});

describe("walk helper", () => {
  test("list every entry without following a link or forging a line", async () => {
    const { base, roots } = scratch();
    const tmp = roots[1]!;
    writeFileSync(join(tmp, "two\nlines"), "a");
    symlinkSync("/etc", join(tmp, "etc"));
    mkdirSync(join(tmp, "d"));
    writeFileSync(join(tmp, "d", "f"), "hello");
    Bun.spawnSync(["mkfifo", join(tmp, "pipe")]);
    const result = await run(walkArgv(LIMITS, roots, using));
    expect(result.code).toBe(0);
    const walk = decodeWalk(result.stdout, roots, WIDE);
    if (!walk.ok) throw new Error(walk.reason);
    const by = new Map(walk.entries.map((entry) => [entry.path, entry]));
    expect(by.get(join(tmp, "two\nlines"))?.type).toBe("f");
    expect(by.get(join(tmp, "etc"))?.type).toBe("l");
    expect(by.get(join(tmp, "pipe"))?.type).toBe("o");
    expect(by.get(join(tmp, "d", "f"))?.sha256).toBe(
      new Bun.CryptoHasher("sha256").update("hello").digest("hex"),
    );
    expect([...by.keys()].some((path) => path.startsWith("/etc/"))).toBe(false);
    expect(walk.entries.length).toBe(7);
    expect(base).not.toBe("");
  });

  test("show a hard link, which the decoder refuses", async () => {
    const { roots } = scratch();
    writeFileSync(join(roots[0]!, "a"), "a");
    linkSync(join(roots[0]!, "a"), join(roots[1]!, "b"));
    const result = await run(walkArgv(LIMITS, roots, using));
    const walk = decodeWalk(result.stdout, roots, WIDE);
    expect(walk.ok ? "ok" : walk.reason).toBe("linked");
  });

  test("stop past its bound", async () => {
    const { roots } = scratch();
    for (const name of ["a", "b", "c"])
      writeFileSync(join(roots[1]!, name), "");
    const result = await run(walkArgv({ ...LIMITS, entries: 3 }, roots, using));
    expect(result.code).toBe(5);
    expect(result.text).toEndWith("WALK over entries 3\n");
    const walk = decodeWalk(result.stdout, roots, WIDE);
    expect(walk.ok ? "ok" : walk.reason).toBe("over");
  });

  test("stop at a file past its cap before reading a byte of it", async () => {
    const { roots } = scratch();
    // sparse: a size with no blocks, which a full read would take long on
    writeFileSync(join(roots[1]!, "huge"), "");
    truncateSync(join(roots[1]!, "huge"), 8 * 2 ** 30);
    const result = await run(
      walkArgv({ ...LIMITS, fileBytes: 2 ** 20 }, roots, using),
    );
    expect(result.code).toBe(5);
    expect(result.text).toEndWith(`WALK over file ${2 ** 20}\n`);
    expect(decodeWalk(result.stdout, roots, WIDE).ok).toBe(false);
  });

  test("stop when the files together pass the total", async () => {
    const { roots } = scratch();
    for (const name of ["a", "b"])
      writeFileSync(join(roots[1]!, name), "x".repeat(600));
    const result = await run(
      walkArgv({ ...LIMITS, totalBytes: 1000 }, roots, using),
    );
    expect(result.code).toBe(5);
    expect(result.text).toEndWith("WALK over bytes 1000\n");
  });
});

describe("pull helper", () => {
  test("frame each file, and a file turned link or fifo as missing", async () => {
    const { base, roots } = scratch();
    const tmp = roots[1]!;
    writeFileSync(join(tmp, "f"), "body\n");
    writeFileSync(join(base, "secret"), "secret");
    symlinkSync(join(base, "secret"), join(tmp, "was-file"));
    Bun.spawnSync(["mkfifo", join(tmp, "pipe")]);
    mkdirSync(join(base, "away"));
    writeFileSync(join(base, "away", "g"), "g");
    symlinkSync(join(base, "away"), join(tmp, "door"));
    const asked = ["f", "was-file", "pipe", "door/g", "none"].map((name) =>
      escapePath(join(tmp, name)),
    );
    const result = await run(
      pullArgv(LIMITS.fileBytes, roots, using),
      pullRequest(asked),
    );
    expect(result.code).toBe(0);
    const pull = decodePull(
      result.stdout,
      roots,
      { fileBytes: 100, totalBytes: 100 },
      asked,
    );
    if (!pull.ok) throw new Error(pull.reason);
    expect(pull.frames.map((frame) => frame.missing)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    const first = pull.frames[0]!;
    if (first.missing) throw new Error("missing");
    expect(new TextDecoder().decode(first.data)).toBe("body\n");
  });

  test("refuse a file past its cap before sending a byte of it", async () => {
    const { roots } = scratch();
    const tmp = roots[1]!;
    writeFileSync(join(tmp, "small"), "ok");
    writeFileSync(join(tmp, "sparse"), "");
    truncateSync(join(tmp, "sparse"), 1 << 30);
    const asked = ["small", "sparse"].map((name) =>
      escapePath(join(tmp, name)),
    );
    const result = await run(pullArgv(100, roots, using), pullRequest(asked));
    expect(result.code).not.toBe(0);
    expect(result.stdout.byteLength).toBeLessThan(200);
    expect(result.text).toEndWith("PULL refused size\n");
    const pull = decodePull(
      result.stdout,
      roots,
      { fileBytes: 100, totalBytes: 100 },
      asked,
    );
    expect(pull.ok ? null : pull.reason).toBe("refused");
  });
});

describe("wrapper", () => {
  function setup() {
    const { base } = scratch();
    const under = join(base, "root");
    for (const tree of ["knowledge", "tmp", "repos/r"])
      mkdirSync(join(under, tree), { recursive: true });
    const records = join(base, "records");
    mkdirSync(records);
    const home = join(base, "home");
    mkdirSync(home);
    return { base, under, records, home };
  }
  const caps = {
    docs: true,
    maxFiles: 10,
    knowledgeFileBytes: 64,
    repoFileBytes: 8,
  };
  async function command(
    s: ReturnType<typeof setup>,
    cwd: string,
    text: string,
    open: typeof caps | null = caps,
    id = idOf("c1"),
  ) {
    const argv = wrapperArgv(
      { cwd, id, command: text, open, records: s.records, under: s.under },
      using,
    );
    return run(argv, undefined, { HOME: s.home });
  }

  test("record the final cwd, and start at home when the saved one is gone", async () => {
    const s = setup();
    const result = await command(
      s,
      join(s.under, "tmp"),
      "mkdir -p a/b && cd a/b; exit 3",
    );
    expect(result.code).toBe(3);
    const paths = recordPaths(idOf("c1"), s.records);
    expect(readFileSync(paths.cwd, "utf8")).toBe(
      join(s.under, "tmp", "a", "b"),
    );
    const gone = await command(
      s,
      join(s.under, "tmp", "nope"),
      "pwd",
      caps,
      idOf("c2"),
    );
    expect(gone.text).toBe(`${s.home}\n`);
    expect(readFileSync(recordPaths(idOf("c2"), s.records).cwd, "utf8")).toBe(
      s.home,
    );
  });

  test("open copies the file with its escaped path, the same slot again", async () => {
    const s = setup();
    writeFileSync(join(s.under, "tmp", "a b.md"), "# one\n");
    const result = await command(
      s,
      join(s.under, "tmp"),
      "open 'a b.md' && echo '# two' > 'a b.md' && open '/tmp/a b.md' && bash -c 'open \"a b.md\"'",
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const opened = recordPaths(idOf("c1"), s.records).opened;
    expect(readFileSync(join(opened, "1.path"), "utf8")).toBe(
      "/tmp/a%20b.md\n",
    );
    expect(readFileSync(join(opened, "1"), "utf8")).toBe("# two\n");
    expect(existsSync(join(opened, "2"))).toBe(false);
  });

  test("open refuses with the built-in shell's words", async () => {
    const s = setup();
    const t = join(s.under, "tmp");
    writeFileSync(join(t, "big.md"), "x".repeat(65));
    writeFileSync(join(s.under, "repos", "r", "nine.md"), "123456789");
    writeFileSync(join(t, "bin"), new Uint8Array([0x61, 0, 0x62]));
    writeFileSync(join(t, "real.md"), "real");
    symlinkSync(join(t, "real.md"), join(t, "link.md"));
    mkdirSync(join(t, "dir"));
    for (let i = 0; i < 11; i++) writeFileSync(join(t, `${i}.md`), "x");
    const cases: [string, string][] = [
      ["open /etc/passwd", "open: /etc/passwd: not in the mount\n"],
      ["open nope.md", "open: nope.md: no such file\n"],
      ["open link.md", "open: link.md: not a regular file\n"],
      ["open dir", "open: dir: not a regular file\n"],
      ["open bin", "open: bin: not text\n"],
      [
        "open big.md",
        "open: big.md: over 64 B, open a smaller part (sed -n '1,200p' f > /tmp/part.md)\n",
      ],
      [
        "open /repos/r/nine.md",
        "open: /repos/r/nine.md: over 8 B, open a smaller part (sed -n '1,200p' f > /tmp/part.md)\n",
      ],
      ["open $'a\\nb'", "open: a\nb: name has a line break\n"],
      ["open $'a\\tb'", "open: a\tb: name has a control character\n"],
      ["open a b", "usage: open <file>\n"],
      ["open -n x", "usage: open <file>\n"],
      ["echo hi | open real.md", "usage: open <file>\n"],
      [
        "for i in 0 1 2 3 4 5 6 7 8 9; do open $i.md; done; open 10.md",
        "open: 10.md: at most 10 files per command\n",
      ],
    ];
    let id = 0;
    for (const [text, words] of cases) {
      const result = await command(s, t, text, caps, idOf(`r${id++}`));
      expect(result.stderr).toBe(words);
      expect(result.code).toBe(1);
    }
    const off = await command(
      s,
      t,
      "open real.md",
      { ...caps, docs: false },
      idOf("k1"),
    );
    expect(off.code).toBe(0);
    writeFileSync(join(s.under, "knowledge", "d.md"), "d");
    const docsOff = await command(
      s,
      t,
      "open /knowledge/d.md",
      { ...caps, docs: false },
      idOf("k2"),
    );
    expect(docsOff.stderr).toBe("open: /knowledge/d.md: no such file\n");
  });

  test("refuse to start over a record already standing for its id", async () => {
    const s = setup();
    const t = join(s.under, "tmp");
    const fifo = recordPaths(idOf("p1"), s.records).cwd;
    Bun.spawnSync(["mkfifo", fifo]);
    mkdirSync(recordPaths(idOf("p2"), s.records).opened);
    symlinkSync("/etc", recordPaths(idOf("p3"), s.records).cwd);
    for (const name of ["p1", "p2", "p3"]) {
      const result = await command(s, t, "echo ran", caps, idOf(name));
      expect([result.code, result.text, result.stderr]).toEqual([
        RECORDS_EXIST.code,
        "",
        `${RECORDS_EXIST.line}\n`,
      ]);
    }
  });

  test("take only a command id too long to guess", () => {
    expect(() => recordPaths("short")).toThrow(TypeError);
    expect(() => recordPaths(`${"a".repeat(21)}/`)).toThrow(TypeError);
    expect(recordPaths(idOf("x")).cwd).toBe(`/sandbox/.1ctx/${idOf("x")}.cwd`);
  });

  test("a subagent's shell defines no open", async () => {
    const s = setup();
    const result = await command(s, join(s.under, "tmp"), "type -t open", null);
    expect(result.text).not.toContain("function");
  });
});

// every word a command can start with in the fence: bash builtins and
// the one function it defines
const BUILTINS = new Set(
  "builtin echo exit kill read local continue break return exec".split(" "),
);
const KEYWORDS = new Set(
  "if then else elif fi for while until do done case esac function".split(" "),
);

// the fence's code with comments, expansions, arithmetic and array
// values folded to placeholders, so what is left is commands
function folded(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\$\{[^}]*\}/g, "X")
    .replace(/\$?\(\([^)]*\)\)/g, "((X))")
    .replace(/\b\w+\+?=\((?!\()[^)]*\)/g, "A=X")
    .replace(/\[\[.*?\]\]/g, "[[X]]");
}

describe("fence argv", () => {
  test("read the start time after the last ), past a name with ) and newlines", () => {
    const tail = Array.from({ length: 50 }, (_, i) => String(i + 4)).join(" ");
    expect(startTimeOf(`42 (x) Z\n1 2 3) S ${tail}\n`)).toBe("22");
    expect(startTimeOf("garbage")).toBeNull();
    expect(fenceArgv(7, "22").slice(-2)).toEqual(["7", "22"]);
    expect(() => fenceArgv(1, "22")).toThrow(TypeError);
    expect(() => fenceArgv(7, "x")).toThrow(TypeError);
  });
});

describe("fence source", () => {
  const source = HELPER_SOURCES.fence;

  test("parses as bash", async () => {
    // -n reads the script without running a line of it
    const result = await run([using.bash, "-n", "-c", source]);
    expect(result.code).toBe(0);
  });

  test("starts no process: no substitution, pipe, subshell or outside command", () => {
    expect(forks(source)).toEqual([]);
    for (const bad of [
      "sleep 1",
      "x=$(builtin echo)",
      "builtin echo | builtin read",
      "( builtin echo )",
      "list() { builtin echo; }; list & builtin echo",
      "for p in 1; do ps; done",
    ])
      expect(forks(`${source}\n${bad}\n`)).not.toEqual([]);
  });
});

// what in a script could start a process: a construct that forks, or a
// command word that is neither a builtin nor a function it defines
function forks(source: string): string[] {
  const code = folded(source);
  const found: string[] = [];
  if (/\$\(|`|<\(|>\(|\bcoproc\b/.test(code)) found.push("substitution");
  if (code.replace(/\|\|/g, "").includes("|")) found.push("pipe");
  if (code.replace(/&&|>&/g, "").includes("&")) found.push("background");
  if (/[()]/.test(code.replace(/\(\(X\)\)|\w+\(\)/g, "")))
    found.push("subshell");
  const defined = new Set(
    [...code.matchAll(/^(\w+)\(\) \{/gm)].map((match) => match[1]!),
  );
  for (const piece of code.split(/\n|;|&&|\|\||\{\s|\s\}/)) {
    let rest = piece.trim();
    const first = () => rest.split(/\s+/)[0] ?? "";
    if (first() === "for") continue;
    while (KEYWORDS.has(first())) rest = rest.slice(first().length).trim();
    if (rest === "" || rest === "}" || rest.startsWith("((X))")) continue;
    if (rest.startsWith("[[") || /^\w+=/.test(rest)) continue;
    if (/^\w+\(\)/.test(rest) || /^\d*[<>]/.test(rest)) continue;
    if (!BUILTINS.has(first()) && !defined.has(first())) found.push(first());
  }
  return found;
}
