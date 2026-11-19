// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A sandbox's filesystem in memory, answering the fixed helpers' execs
// as the helpers do: push frames applied, the walk's lines, the pull's
// frames, the fence, the records' removal, a folder check, and the
// wrapper, whose command a test plays on the tree. Any step can be told
// to fail, lie or hang, so the backend runs end to end over it.

import { escapePath, unescapePath } from "../../src/server/sandbox/frames.ts";
import type {
  ExecEvent,
  ExecRequest,
} from "../../src/server/sandbox/gateway.ts";
import { SandboxUnavailable } from "../../src/server/sandbox/gateway.ts";
import { HELPER_SOURCES } from "../../src/server/sandbox/helpers.ts";

export type FakeNode =
  | { kind: "dir"; mode: number; mtime: number }
  | {
      kind: "file";
      mode: number;
      mtime: number;
      data: Uint8Array;
      nlink?: number;
    }
  | { kind: "link"; target: string }
  | { kind: "other"; mode: number };

export type Step =
  | "push"
  | "fence"
  | "walk"
  | "pull"
  | "check"
  | "records"
  | "command";

// what a command did, as the test plays it on the tree
export type CommandEffect = {
  stdout?: string | Uint8Array;
  stderr?: string;
  exit?: number;
  // the final cwd the wrapper records; null leaves no record
  pwd?: string | null;
  // open's copies, as the wrapper's open writes them
  opened?: { path: string; text: string }[];
};

export type CommandCall = {
  fs: FakeFs;
  cwd: string;
  id: string;
  command: string;
  open: boolean;
  environment: Record<string, string>;
  signal: AbortSignal;
};

const text = (value: string) => new TextEncoder().encode(value);
const sha = (data: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

export const ROOT_PATHS = ["/knowledge", "/tmp", "/uploads", "/mcp"];
export const RECORDS = "/sandbox/.1ctx";

export class FakeFs {
  readonly nodes = new Map<string, FakeNode>();
  // every exec answered, by step
  readonly calls: Step[] = [];
  // every push frame applied, as "<op> <path>"
  readonly frames: string[] = [];
  // a step told to fail: exit non-zero, or throw as a lost transport
  broken = new Map<Step, "exit" | "throw" | "hang" | "unavailable">();
  // the walk's lines before they go out, for a walk that lies
  walkLines?: (lines: string[]) => string[];
  // the pull's frames before they go out
  pullFrames?: (frames: Uint8Array[]) => Uint8Array[];
  onCommand?: (call: CommandCall) => CommandEffect | Promise<CommandEffect>;

  constructor() {
    for (const root of ROOT_PATHS)
      this.nodes.set(root, {
        kind: "dir",
        mode: root === "/tmp" ? 0o1777 : 0o755,
        mtime: 0,
      });
    this.nodes.set(RECORDS, { kind: "dir", mode: 0o755, mtime: 0 });
  }

  // the files and folders under the roots, for an assert
  tree(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, node] of [...this.nodes].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (!ROOT_PATHS.some((root) => path.startsWith(`${root}/`))) continue;
      out[path] =
        node.kind === "file"
          ? `${node.mode.toString(8)} ${node.mtime} ${new TextDecoder().decode(node.data)}`
          : node.kind === "dir"
            ? `dir ${node.mode.toString(8)} ${node.mtime}`
            : node.kind;
    }
    return out;
  }

  write(path: string, data: string | Uint8Array, mode = 0o644, mtime = 0) {
    for (
      let at = parentOf(path);
      at !== "" && !this.nodes.has(at);
      at = parentOf(at)
    )
      this.nodes.set(at, { kind: "dir", mode: 0o755, mtime });
    this.nodes.set(path, {
      kind: "file",
      mode,
      mtime,
      data: typeof data === "string" ? text(data) : data,
    });
  }

  remove(path: string) {
    for (const key of [...this.nodes.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }

  children(path: string): string[] {
    return [...this.nodes.keys()]
      .filter((key) => parentOf(key) === path)
      .sort();
  }

  async *exec(request: ExecRequest): AsyncGenerator<ExecEvent> {
    const [head, , , , source] = request.command;
    let step: Step;
    if (head === "/usr/bin/find") step = "records";
    else if (source === HELPER_SOURCES.push) step = "push";
    else if (source === HELPER_SOURCES.walk) step = "walk";
    else if (source === HELPER_SOURCES.pull) step = "pull";
    else if (source === HELPER_SOURCES.fence) step = "fence";
    else if (source === HELPER_SOURCES.wrapper) step = "command";
    else if (source === "[[ -d $1 ]]") step = "check";
    else throw new Error("the fake sandbox runs only the fixed helpers");
    this.calls.push(step);
    const broken = this.broken.get(step);
    if (broken === "throw") throw new Error("fake exec lost");
    if (broken === "unavailable")
      throw new SandboxUnavailable("sandbox is not ready");
    if (broken === "hang")
      await new Promise((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    if (broken === "exit") {
      yield { exit: step === "fence" ? 4 : 1 };
      return;
    }
    if (step === "command") {
      yield* this.command(request);
      return;
    }
    const out = this.answer(step, request);
    for (const chunk of out.stdout) yield { stream: "stdout", data: chunk };
    yield { exit: out.exit };
  }

  private answer(
    step: Step,
    request: ExecRequest,
  ): { stdout: Uint8Array[]; exit: number } {
    const argv = request.command;
    switch (step) {
      case "records": {
        // every record, or only the paths of one command's -path tests
        const only = argv.flatMap((arg, at) =>
          argv[at - 1] === "-path" ? [arg] : [],
        );
        const named = (path: string) =>
          only.some((pattern) =>
            pattern.endsWith("/*")
              ? path.startsWith(pattern.slice(0, -1))
              : path === pattern,
          );
        for (const path of [...this.nodes.keys()])
          if (
            path.startsWith(`${argv[1]}/`) &&
            (only.length === 0 || named(path))
          )
            this.nodes.delete(path);
        return { stdout: [], exit: 0 };
      }
      case "check": {
        const node = this.nodes.get(argv[6]!);
        return { stdout: [], exit: node?.kind === "dir" ? 0 : 1 };
      }
      case "fence":
        return { stdout: [text("FENCE ok stopped=0 rounds=1\n")], exit: 0 };
      case "push":
        return this.push(request.stdin ?? new Uint8Array(), argv.slice(5));
      case "walk": {
        const [entries, file, total] = argv.slice(5, 8).map(Number);
        let lines = this.walk(argv.slice(8), entries!, file!, total!);
        lines = this.walkLines?.(lines) ?? lines;
        const exit = lines.at(-1)?.startsWith("WALK over") ? 5 : 0;
        return {
          stdout: [text(lines.map((line) => `${line}\n`).join(""))],
          exit,
        };
      }
      default: {
        let frames = this.pull(request.stdin ?? new Uint8Array(), argv[5]!);
        frames = this.pullFrames?.(frames) ?? frames;
        return { stdout: frames, exit: 0 };
      }
    }
  }

  private push(
    stdin: Uint8Array,
    roots: string[],
  ): { stdout: Uint8Array[]; exit: number } {
    let at = 0;
    let n = 0;
    const done = (line: string, exit: number) => ({
      stdout: [text(`${line}\n`)],
      exit,
    });
    while (at < stdin.byteLength) {
      const end = stdin.indexOf(0x0a, at);
      const h = JSON.parse(new TextDecoder().decode(stdin.subarray(at, end)));
      at = end + 1;
      const path = new TextDecoder().decode(unescapePath(h.path)!);
      if (roots.includes(path)) return done(`PUSH refused root ${h.path}`, 2);
      if (!roots.some((root) => path.startsWith(`${root}/`)))
        return done(`PUSH refused outside ${h.path}`, 2);
      if (this.nodes.get(parentOf(path))?.kind !== "dir")
        return done(`PUSH refused missing ${h.path}`, 2);
      const node = this.nodes.get(path);
      // as push.py, a frame whose path no longer holds what it expects
      const holds =
        node === undefined ? null : node.kind === "file" ? sha(node.data) : "";
      if ("was" in h && holds !== h.was) {
        at += h.size ?? 0;
        this.frames.push(`skip ${path}`);
        n++;
        continue;
      }
      if (h.op === "rm") {
        if (node?.kind === "dir" && this.children(path).length > 0)
          return done(`PUSH refused notempty ${h.path}`, 2);
        this.nodes.delete(path);
      } else if (h.op === "dir") {
        if (node !== undefined && node.kind !== "dir")
          return done("PUSH refused kind", 2);
        this.nodes.set(path, { kind: "dir", mode: h.mode, mtime: h.mtime });
      } else if (h.op === "meta") {
        if (node === undefined || (node.kind !== "dir" && node.kind !== "file"))
          return done(`PUSH refused missing ${h.path}`, 2);
        node.mode = h.mode;
        node.mtime = h.mtime;
      } else {
        const data = stdin.slice(at, at + h.size);
        at += h.size;
        if (node?.kind === "dir") return done("PUSH refused kind", 2);
        const before =
          h.append && node?.kind === "file" ? node.data : new Uint8Array();
        const joined = new Uint8Array(before.byteLength + data.byteLength);
        joined.set(before);
        joined.set(data, before.byteLength);
        this.nodes.set(path, {
          kind: "file",
          mode: h.mode,
          mtime: h.mtime,
          data: joined,
        });
      }
      this.frames.push(`${h.op} ${path}`);
      n++;
    }
    return done(`PUSH ok ${n}`, 0);
  }

  private walk(
    roots: string[],
    limit: number,
    most: number,
    total: number,
  ): string[] {
    const lines: string[] = [];
    let n = 0;
    let held = 0;
    const visit = (path: string): boolean => {
      const node = this.nodes.get(path)!;
      if (n >= limit) {
        lines.push(`WALK over entries ${limit}`);
        return false;
      }
      n++;
      const esc = escapePath(path);
      if (node.kind === "dir") {
        lines.push(`d ${node.mode.toString(8)} 0 2 - ${esc}`);
        for (const child of this.children(path))
          if (!visit(child)) return false;
      } else if (node.kind === "file") {
        if (node.data.byteLength > most) {
          lines.push(`WALK over file ${most}`);
          return false;
        }
        held += node.data.byteLength;
        if (held > total) {
          lines.push(`WALK over bytes ${total}`);
          return false;
        }
        lines.push(
          `f ${node.mode.toString(8)} ${node.data.byteLength} ${node.nlink ?? 1} ${sha(node.data)} ${esc}`,
        );
      } else if (node.kind === "link")
        lines.push(`l 777 ${node.target.length} 1 - ${esc}`);
      else lines.push(`o ${node.mode.toString(8)} 0 1 - ${esc}`);
      return true;
    };
    for (const root of roots) {
      if (!this.nodes.has(root)) {
        lines.push(`E ENOENT ${escapePath(root)}`);
        continue;
      }
      if (!visit(root)) return lines;
    }
    lines.push(`WALK done ${n}`);
    return lines;
  }

  // every pull request's stdin, in order
  readonly pulled: Uint8Array[] = [];

  private pull(stdin: Uint8Array, cap: string): Uint8Array[] {
    this.pulled.push(stdin);
    const asked = new TextDecoder().decode(stdin).split("\n").filter(Boolean);
    const out: Uint8Array[] = [];
    for (const esc of asked) {
      const path = new TextDecoder().decode(unescapePath(esc)!);
      const node = this.nodes.get(path);
      if (node?.kind !== "file") {
        out.push(text(`${JSON.stringify({ path: esc, missing: true })}\n`));
        continue;
      }
      if (node.data.byteLength > Number(cap)) {
        out.push(text("PULL refused size\n"));
        return out;
      }
      out.push(
        text(
          `${JSON.stringify({ path: esc, size: node.data.byteLength, mode: node.mode })}\n`,
        ),
      );
      out.push(node.data);
    }
    out.push(text(`PULL done ${asked.length}\n`));
    return out;
  }

  private async *command(request: ExecRequest): AsyncGenerator<ExecEvent> {
    const argv = request.command;
    const [cwd, id, command, on, records] = argv.slice(6, 11) as string[];
    const base = `${records}/${id}`;
    if (this.nodes.has(`${base}.cwd`) || this.nodes.has(`${base}.opened`)) {
      yield { stream: "stderr", data: text("WRAPPER records exist\n") };
      yield { exit: 126 };
      return;
    }
    const effect =
      (await this.onCommand?.({
        fs: this,
        cwd: cwd!,
        id: id!,
        command: command!,
        open: on === "on",
        environment: request.environment ?? {},
        signal: request.signal,
      })) ?? {};
    request.signal.throwIfAborted();
    const pwd = effect.pwd === undefined ? cwd! : effect.pwd;
    if (pwd !== null)
      this.nodes.set(`${base}.cwd`, {
        kind: "file",
        mode: 0o644,
        mtime: 0,
        data: text(pwd),
      });
    (effect.opened ?? []).forEach((file, index) => {
      this.write(`${base}.opened/${index + 1}`, file.text);
      this.write(
        `${base}.opened/${index + 1}.path`,
        `${escapePath(file.path)}\n`,
      );
    });
    if (effect.stdout !== undefined)
      yield {
        stream: "stdout",
        data:
          typeof effect.stdout === "string"
            ? text(effect.stdout)
            : effect.stdout,
      };
    if (effect.stderr) yield { stream: "stderr", data: text(effect.stderr) };
    yield { exit: effect.exit ?? 0 };
  }
}
