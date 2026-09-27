// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fake decisions server: a recorded answer of the model asked, laid
// on the questions asked. Each asked question takes the recorded answer
// of its type, so any id and any yes/no work; a choice or a score must
// ask the recorded options. A type the model refused when recorded gets
// the recorded refusal, naming the question.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "providers", "systemone", name),
    "utf8",
  );

const RECORDED: Record<string, string> = {
  "typesafe/jev-1.13": "jev-answer.json",
  "jaredpalmer/kev-4b": "kev-answer.json",
  "respan/span-01-lite:free": "span-noul.json",
  "kev-latest": "kev-serve-answer.json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function systemoneAnswer(body: string | null): Response {
  const asked = JSON.parse(body ?? "{}") as {
    model?: string;
    questions?: Record<string, { type: string }>;
  };
  const name = RECORDED[asked.model ?? ""];
  if (name === undefined) {
    return json({ error: { message: "model not found", code: 404 } }, 404);
  }
  const recorded = JSON.parse(fixture(name)) as {
    answers: Record<string, { type: string }>;
  };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(asked.questions ?? {})) {
    const answer = Object.values(recorded.answers).find(
      (a) => a.type === question.type,
    );
    if (answer === undefined) {
      const refused = fixture("span-refused-400.json").replace(
        '\\"outcome\\"',
        `\\"${id}\\"`,
      );
      return new Response(refused, { status: 400 });
    }
    answers[id] = answer;
  }
  return json({ ...recorded, answers });
}

export const decisionsCatalog = () => fixture("openrouter-catalog.json");
export const kevServeModels = () => fixture("kev-serve-models.json");
