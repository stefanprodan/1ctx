// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file a /knowledge/ path in a reply names now, read when its link
// is clicked; the page then replaces itself with the file's page.

import { signal } from "@preact/signals";
import type { KnowledgePathResponse } from "../../shared/api/knowledge.ts";
import { type Failure, failure } from "../lib/format.ts";
import { ApiError, api } from "./api.ts";

export type PathAnswer =
  | { state: "loading" }
  | { state: "found"; fileId: string }
  | { state: "missing" }
  | { state: "failed"; failure: Failure };

// the answer for one project and name, so a late one for another link
// never moves the page
export const pathAnswer = signal<{
  key: string;
  answer: PathAnswer;
} | null>(null);

export const pathKey = (projectId: string, name: string) =>
  `${projectId}\n${name}`;

let turn = 0;

export async function loadKnowledgePath(
  projectId: string,
  name: string,
): Promise<void> {
  const mine = ++turn;
  const key = pathKey(projectId, name);
  pathAnswer.value = { key, answer: { state: "loading" } };
  let answer: PathAnswer;
  try {
    const { fileId } = await api<KnowledgePathResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/knowledge/path?name=${encodeURIComponent(name)}`,
    );
    answer = { state: "found", fileId };
  } catch (err) {
    // a bad name is no file either, as the file page says of a bad id
    answer =
      err instanceof ApiError && (err.status === 404 || err.status === 400)
        ? { state: "missing" }
        : { state: "failed", failure: failure(err) };
  }
  if (turn === mine) pathAnswer.value = { key, answer };
}
