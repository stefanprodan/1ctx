// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One routine for `1ctx provision` and the server's --provision: check
// the objects against a snapshot, then apply them through an app over
// the real file, closed again before anything else opens it.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Db, heldByAnother, inspect, open } from "../db/index.ts";
import type { Counts } from "./apply.ts";
import { readSources } from "./input.ts";
import { loadKnowledge } from "./knowledge.ts";
import { type Document, parse } from "./parse.ts";

export type ProvisionApp = {
  provision: {
    validate(documents: Document[]): unknown;
    apply(
      documents: Document[],
      output?: (line: string) => void,
    ): Promise<Counts>;
  };
  shutdown(): Promise<unknown>;
};

export type ProvisionRun = {
  paths: string[];
  dbPath: string;
  // an app over this db that starts nothing of its own
  compose(db: Db): Promise<ProvisionApp>;
  output?: (line: string) => void;
  // at server start a missing path or a folder with no YAML is no error
  optional?: boolean;
};

export type ProvisionResult = { counts: Counts; migrations: string[] };

export async function provisionPaths(
  run: ProvisionRun,
): Promise<ProvisionResult | null> {
  const { dbPath } = run;
  if (heldByAnother(dbPath)) {
    throw new Error(
      `another process has ${dbPath} open; stop the server before provisioning`,
    );
  }
  const paths = run.optional
    ? run.paths.filter((path) => existsSync(path))
    : run.paths;
  if (paths.length === 0) return null;
  const sources = await readSources(paths);
  if (run.optional && sources.length === 0) return null;
  const documents = await loadKnowledge(parse(sources));

  const snapshot = inspect(dbPath);
  try {
    const check = await run.compose(snapshot);
    try {
      check.provision.validate(documents);
    } finally {
      await check.shutdown();
    }
  } finally {
    snapshot.close();
  }

  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const { db, migrations } = open(dbPath);
  try {
    const app = await run.compose(db);
    try {
      const counts = await app.provision.apply(
        documents,
        run.output ?? (() => {}),
      );
      return { counts, migrations };
    } finally {
      await app.shutdown();
    }
  } finally {
    db.close();
  }
}
