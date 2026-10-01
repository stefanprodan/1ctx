// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send's repositories: looked up when it starts, the commits stored
// on its first message, the trees held until it ends. The model is told
// each mounted one in the bash description, a branch that moved since
// the chat's last turn in one line, and the ones turned off after a turn
// read them.

import { repoOf } from "../../shared/capabilities.ts";
import {
  isCommit,
  type Prepared,
  type PrepareOptions,
  type RepoMount,
} from "../repos/index.ts";
import type { MountedRepos } from "../sessions/index.ts";
import type { ActiveSend } from "./send.ts";

export type ReposPort = {
  prepare(projectId: string, options: PrepareOptions): Promise<Prepared>;
  // the project's repositories, for the names of the ones off
  switchable(projectId: string): { id: string; name: string }[];
};

export type MountedPort = {
  mountedRepos(messageId: string): MountedRepos | null;
  setMountedRepos(messageId: string, mounted: MountedRepos): void;
  mountedBefore(
    sessionId: string,
    sendId: string,
    limit: number,
  ): MountedRepos[];
};

const short = (commit: string) => commit.slice(0, 7);

const refWords = (ref: string) =>
  ref === "" ? "default branch" : isCommit(ref) ? short(ref) : ref;

// /repos/podinfo: github.com/stefanprodan/podinfo at master (8d01e44), read-only
export function repoLine(mount: RepoMount): string {
  const where = mount.url.replace(/^https:\/\//, "");
  const at = isCommit(mount.ref)
    ? short(mount.commit)
    : `${refWords(mount.ref)} (${short(mount.commit)})`;
  const ignored = mount.ignored > 0 ? ", some paths ignored" : "";
  return `/repos/${mount.name}: ${where} at ${at}, read-only${ignored}`;
}

// what the first command says of the repositories left out
function noticeOf(prepared: Prepared): string {
  return [
    ...prepared.notices.map(
      (notice) => `repo ${notice.name} is unavailable: ${notice.reason}\n`,
    ),
    ...prepared.mounts
      .filter((mount) => mount.missedPin !== null)
      .map(
        (mount) =>
          `repo ${mount.name}: ${short(mount.missedPin!)} is no longer cached, mounted ${short(mount.commit)}\n`,
      ),
  ].join("");
}

// before the first round of a send that offers bash; send.repos is set
// as soon as trees are held, so the runner's end releases them however
// the send ends
export async function mountRepos(
  deps: {
    repos: ReposPort;
    sessions: MountedPort;
    // repoFileBytes, read once there is a tree to read
    fileBytes(): number;
  },
  send: ActiveSend,
): Promise<void> {
  const tools = send.policy.offered.tools;
  const at = tools.findIndex((tool) => tool.name === "bash");
  if (at < 0) return;
  const off = new Set<string>();
  for (const key of send.policy.disabledCapabilities) {
    const id = repoOf(key);
    if (id !== null) off.add(id);
  }
  // a regenerate mounts what the turn it replaces read, when it can
  const original =
    send.op === "regenerate"
      ? deps.sessions.mountedRepos(send.firstMessageId)
      : null;
  const prepared = await deps.repos.prepare(send.projectId, {
    off,
    ...(original === null ? {} : { pinned: new Map(Object.entries(original)) }),
    signal: send.controller.signal,
  });
  let pending = noticeOf(prepared);
  send.repos = {
    tool: {
      mounts: prepared.mounts.map(({ name, folder, files, bytes }) => ({
        name,
        folder,
        files,
        bytes,
      })),
      fileBytes: prepared.mounts.length > 0 ? deps.fileBytes() : 0,
      notice: () => {
        const notice = pending;
        pending = "";
        return notice;
      },
    },
    off: [],
    moved: [],
    release: prepared.release,
  };
  if (prepared.mounts.length > 0 || original !== null) {
    deps.sessions.setMountedRepos(
      send.firstMessageId,
      Object.fromEntries(
        prepared.mounts.map((mount) => [mount.repoId, mount.commit]),
      ),
    );
  }
  if (prepared.mounts.length > 0) {
    const [last] = deps.sessions.mountedBefore(send.sessionId, send.id, 1);
    send.repos.moved = prepared.mounts.flatMap((mount) => {
      const before = last?.[mount.repoId];
      return before === undefined || before === mount.commit
        ? []
        : [
            `repo ${mount.name}: ${refWords(mount.ref)} moved from ${short(before)} to ${short(mount.commit)}`,
          ];
    });
    const bash = tools[at]!;
    send.policy.offered.tools = tools.map((tool, i) =>
      i === at
        ? {
            ...bash,
            description: [
              bash.description,
              ...prepared.mounts.map(repoLine),
            ].join("\n"),
          }
        : tool,
    );
  }
  if (off.size > 0) {
    const names = deps.repos
      .switchable(send.projectId)
      .filter((repo) => off.has(repo.id));
    if (names.length > 0) {
      const read = new Set(
        deps.sessions
          .mountedBefore(send.sessionId, send.id, -1)
          .flatMap((mounted) => Object.keys(mounted)),
      );
      send.repos.off = names
        .filter((repo) => read.has(repo.id))
        .map((repo) => repo.name)
        .sort();
    }
  }
}
