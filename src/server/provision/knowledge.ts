// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's docs from a folder beside the YAML. Reading is the only
// I/O; the names and the text follow the rules the knowledge routes
// apply, so a refusal comes before anything is written.

import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isLeftOut, textFromBytes } from "../../shared/knowledge.ts";
import { isKnowledgeName } from "../../shared/words.ts";
import type { Document, KnowledgeDoc } from "./parse.ts";

// past the largest project a limit allows, so a wrong folder (a home
// directory) stops early instead of being read whole
const MAX_WALKED = 10_000;

export async function loadKnowledge(
  documents: Document[],
): Promise<Document[]> {
  const out: Document[] = [];
  for (const doc of documents) {
    if (doc.kind !== "Project" || doc.spec.knowledge === undefined) {
      out.push(doc);
      continue;
    }
    const folder = doc.spec.knowledge;
    const fail = (message: string): never => {
      throw new Error(
        `${doc.source}: Project/${doc.name}: spec.knowledge ${message}`,
      );
    };
    if (doc.source === "-") fail("needs a file to be relative to, not stdin");
    const root = resolve(dirname(doc.source), folder);
    const docs = await walk(root, (path, message) =>
      fail(`${path === "" ? folder : `${folder}/${path}`}: ${message}`),
    );
    out.push({ ...doc, docs });
  }
  return out;
}

async function walk(
  root: string,
  fail: (path: string, message: string) => never,
): Promise<KnowledgeDoc[]> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(root);
  } catch {
    return fail("", "does not exist");
  }
  if (info.isSymbolicLink()) fail("", "is a symlink");
  if (!info.isDirectory()) fail("", "is not a folder");
  const docs: KnowledgeDoc[] = [];
  let walked = 0;
  const visit = async (relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return fail(relative, "could not be read");
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (isLeftOut(path)) continue;
      if (++walked > MAX_WALKED) fail("", `holds over ${MAX_WALKED} entries`);
      if (entry.isSymbolicLink()) fail(path, "is a symlink");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) fail(path, "is not a regular file");
      if (!isKnowledgeName(path)) {
        fail(
          path,
          "is not a valid name: 1 to 8 path segments of letters, digits, dots, dashes or underscores, at most 80 characters each and 200 total",
        );
      }
      let text: string;
      try {
        text = textFromBytes(await readFile(join(root, path)));
      } catch {
        return fail(path, "is not a text file");
      }
      docs.push({
        name: path,
        text,
        bytes: new TextEncoder().encode(text).byteLength,
      });
    }
  };
  await visit("");
  return docs;
}
