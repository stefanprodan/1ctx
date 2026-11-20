// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a sandbox is made with: pure, from the settings, the caps and the
// repositories a command prepared, so a test reads the exact create.

import type { SandboxVariant } from "../../shared/contracts/sandbox.ts";
import {
  MAX_OPENS_PER_COMMAND,
  type ShellRepo,
  type StoredBytes,
} from "../bash/index.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import type { CreateSpec, SandboxPolicy } from "./gateway.ts";

const MiB = 1024 * 1024;
// room past a cap for folders and the filesystem's own blocks
export const TREE_SLACK_BYTES = 8 * MiB;
// /sandbox/.1ctx: the cwd records and a command's opened copies, each a
// file no larger than one doc
const STATE_BYTES = 4 * MiB;

export const INSTANCE_LABEL = "onectx.dev/instance";

// the sandbox's own process, which keeps it running between commands
// and is the one process of the workload's user a fence spares
export const KEEP_ALIVE = ["/usr/bin/sleep", "infinity"];

// programs' own files: HOME. OpenShell keeps the image's home and
// working folder (/sandbox in ours) for its
// workspace and fails a create that mounts there, so HOME is a folder
// the image never names as either
export const HOME = "/opt/home";

// what every exec of ours and every command runs with: OpenShell's
// execs see none of the image's ENV, and HOME would be the passwd one.
// One set for every variant: a language's variables do nothing where
// its toolchain is missing
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  HOME,
  TMPDIR: "/sandbox/tmp",
  UV_CACHE_DIR: `${HOME}/.cache/uv`,
  UV_LINK_MODE: "copy",
  // bun's cache and global packages stay in HOME, never /knowledge,
  // which is saved after a command
  BUN_INSTALL: `${HOME}/.bun`,
  BUN_INSTALL_CACHE_DIR: `${HOME}/.bun/install/cache`,
  // Go's caches and modules, and what go install builds, in HOME
  GOPATH: `${HOME}/go`,
  GOCACHE: `${HOME}/go/cache`,
  GOMODCACHE: `${HOME}/go/pkg/mod`,
  CGO_ENABLED: "1",
  CC: "gcc",
  // the image's Rust toolchain is in HOME, since /usr is read-only, so
  // rustup can add another beside it
  CARGO_HOME: `${HOME}/.cargo`,
  RUSTUP_HOME: `${HOME}/.rustup`,
  DO_NOT_TRACK: "1",
  PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:${HOME}/go/bin:${HOME}/.cargo/bin`,
};

// the roots the image makes; only these are writable, never /sandbox
// itself. The devices are what shells and the fence open: a pty (the
// fence's timed read), /dev/zero, /dev/random and /dev/tty
export const POLICY: SandboxPolicy = {
  readOnly: [
    "/bin",
    "/usr",
    "/lib",
    "/etc",
    "/proc",
    "/dev/urandom",
    "/sys/fs/cgroup",
    "/repos",
  ],
  readWrite: [
    "/knowledge",
    "/tmp",
    "/uploads",
    "/mcp",
    HOME,
    "/sandbox/tmp",
    "/sandbox/.1ctx",
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/tty",
    "/dev/ptmx",
    "/dev/pts",
  ],
};

// the variant's image the release that built this binary pushed beside
// its own, never a moving tag, since the environment above and the
// image's layout ship together; a source run or a dev build runs the
// dev tag make sandbox-image loads
export function defaultImage(version: string, variant: SandboxVariant): string {
  const release =
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) &&
    !version.startsWith("v0.0.0");
  return `ghcr.io/stefanprodan/1ctx-shell:${release ? version : "dev"}-${variant}`;
}

// the image a sandbox runs: a custom one as saved, else the variant's
export const imageOf = (
  version: string,
  variant: SandboxVariant,
  image: string | null,
): string => image ?? defaultImage(version, variant);

export const gatewayLabel = (instanceId: string) => `1ctx-${instanceId}`;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// the gateway refuses a name over 19 characters, so the instance is in
// the label alone: 1ctx- and 14 random lowercase letters and digits
export function sandboxName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let tail = "";
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length];
  return `1ctx-${tail}`;
}

// the repositories a sandbox mounts, as one comparable key: mounts are
// fixed at create, so a command whose key differs needs a new sandbox
export function mountsKey(repos: readonly ShellRepo[]): string {
  return JSON.stringify(
    [...repos]
      .map((repo) => [repo.name, repo.tree])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );
}

// whether a sandbox sized from the caps alone holds what is stored: a
// tree over a lowered cap needs its own
export function fitsCaps(caps: KnowledgeCaps, stored: StoredBytes): boolean {
  return (
    stored.docs <= caps.knowledgeProjectBytes &&
    stored.uploads <= caps.uploadBytes &&
    stored.kept <= caps.mcpKeptBytes
  );
}

export function createSpec(input: {
  name: string;
  instanceId: string;
  image: string;
  caps: KnowledgeCaps & SandboxCaps;
  repos: readonly ShellRepo[];
  // what the call's trees hold; none for a warm sandbox
  stored?: StoredBytes;
}): CreateSpec {
  const { caps } = input;
  // A tree over a lowered cap is sized to what it holds, so the command
  // that shrinks it can mount it. /tmp, HOME and /sandbox/tmp are the
  // container's own disk, which the memory limit does not count
  const tree = (target: string, cap: number, held = 0) => ({
    type: "tmpfs" as const,
    target,
    sizeBytes: Math.max(cap, held) + TREE_SLACK_BYTES,
    exec: false,
  });
  const stored = input.stored;
  return {
    name: input.name,
    labels: { [INSTANCE_LABEL]: input.instanceId },
    image: input.image,
    command: KEEP_ALIVE,
    cpus: caps.sandboxCpus,
    memoryMiB: caps.sandboxMemoryMiB,
    policy: POLICY,
    mounts: [
      tree("/knowledge", caps.knowledgeProjectBytes, stored?.docs),
      tree("/uploads", caps.uploadBytes, stored?.uploads),
      tree("/mcp", caps.mcpKeptBytes, stored?.kept),
      {
        type: "tmpfs",
        target: "/sandbox/.1ctx",
        sizeBytes:
          STATE_BYTES + (MAX_OPENS_PER_COMMAND + 1) * caps.knowledgeFileBytes,
        exec: false,
      },
      ...input.repos.map((repo) => ({
        type: "bind" as const,
        source: repo.tree,
        target: `/repos/${repo.name}`,
      })),
    ],
  };
}
