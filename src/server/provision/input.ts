// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "./parse.ts";

export async function readSources(
  paths: string[],
  stdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<Source[]> {
  if (paths.length === 0) throw new Error("at least one -f input is required");
  const sources: Source[] = [];
  let input: Promise<string> | undefined;
  async function read(path: string): Promise<void> {
    try {
      sources.push({ path, text: await Bun.file(path).text() });
    } catch {
      throw new Error(`${path}: could not read input`);
    }
  }
  for (const path of paths) {
    if (path === "-") {
      try {
        input ??= stdin();
        sources.push({ path: "-", text: await input });
      } catch {
        throw new Error("-: could not read stdin");
      }
      continue;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`${path}: could not read input`);
    }
    if (info.isFile()) {
      await read(path);
    } else if (info.isDirectory()) {
      let files: string[];
      try {
        files = (await readdir(path))
          .filter((name) => /\.ya?ml$/.test(name))
          .sort();
      } catch {
        throw new Error(`${path}: could not read directory`);
      }
      for (const name of files) {
        const file = join(path, name);
        let isFile: boolean;
        try {
          isFile = (await stat(file)).isFile();
        } catch {
          throw new Error(`${file}: could not read input`);
        }
        if (isFile) await read(file);
      }
    } else {
      throw new Error(`${path}: input must be a file or directory`);
    }
  }
  return sources;
}
