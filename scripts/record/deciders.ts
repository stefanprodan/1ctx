// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what decision models answer into test/fixtures/providers/
// systemone/, for the systemone and catalog tests:
//
//   KEY_FILE=.preview/secrets/provider-openrouter.key \
//   KEV_URL=http://<host>:<port>/v1 bun scripts/record/deciders.ts
//
// OpenRouter's decisions catalog, one answer of each type from Jev and
// Kev-4B, a yes/no and a refused choice from Respan's free model, and a
// kev.serve's model list and answer when KEV_URL is set. It spends well
// under a cent. The key is read from its file and never written out.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OPENROUTER = "https://openrouter.ai/api/v1";
const OUT = new URL("../../test/fixtures/providers/systemone/", import.meta.url)
  .pathname;

const keyFile = process.env.KEY_FILE;
if (!keyFile) {
  console.error("KEY_FILE must name the OpenRouter provider key file");
  process.exit(1);
}
const key = readFileSync(keyFile, "utf8").trim();
const kev = process.env.KEV_URL?.replace(/\/+$/, "") || undefined;

const STATE =
  "Flux check at 14:05: the FluxInstance failed to pull from ghcr.io " +
  "with a DNS error, and 9 Kustomizations are not ready.";

const QUESTIONS = {
  outcome: {
    type: "choice",
    instructions: "What is the outcome of this task run?",
    criteria: {
      "all-good": "The task finished and everything is fine; nothing to do",
      "needs-attention":
        "The task could not finish, or it found a problem that a person should look into",
    },
  },
  severity: {
    type: "score",
    instructions: "How severe is the problem the report names?",
    criteria: ["none", "minor", "major", "critical"],
  },
  act: {
    type: "noul",
    instructions: "Does this report ask a person to do something?",
  },
};

// nothing that holds the key or names a host reaches a fixture
const scrub = (text: string) =>
  text.replaceAll(key, "[key]").replaceAll(kev ?? "\u0000", "[kev]");

async function save(name: string, body: string): Promise<void> {
  const text = scrub(body);
  let pretty = text;
  try {
    pretty = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {}
  await writeFile(join(OUT, name), pretty);
  console.log(`${name} written`);
}

async function get(url: string, auth: boolean): Promise<string> {
  const res = await fetch(url, {
    headers: auth ? { authorization: `Bearer ${key}` } : {},
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${scrub(url)}`);
  return text;
}

async function ask(
  base: string,
  auth: boolean,
  model: string,
  questions: object,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, state: STATE, questions }),
  });
  return { status: res.status, text: await res.text() };
}

await mkdir(OUT, { recursive: true });
await save(
  "openrouter-catalog.json",
  await get(`${OPENROUTER}/models?output_modalities=decisions`, true),
);
let spent = 0;
for (const [name, model] of [
  ["jev", "typesafe/jev-1.13"],
  ["kev", "jaredpalmer/kev-4b"],
] as const) {
  const answer = await ask(OPENROUTER, true, model, QUESTIONS);
  if (answer.status !== 200) {
    throw new Error(`${model} answered ${answer.status}`);
  }
  spent += JSON.parse(answer.text).usage?.cost ?? 0;
  await save(`${name}-answer.json`, answer.text);
}
const span = "respan/span-01-lite:free";
const yes = await ask(OPENROUTER, true, span, { act: QUESTIONS.act });
if (yes.status !== 200) throw new Error(`${span} answered ${yes.status}`);
await save("span-noul.json", yes.text);
const refused = await ask(OPENROUTER, true, span, {
  outcome: QUESTIONS.outcome,
});
if (refused.status < 400 || refused.status >= 500) {
  throw new Error(`${span} answered ${refused.status}, not a refusal`);
}
await save(`span-refused-${refused.status}.json`, refused.text);
if (kev !== undefined) {
  await save("kev-serve-models.json", await get(`${kev}/models`, false));
  const answer = await ask(kev, false, "kev-latest", QUESTIONS);
  if (answer.status !== 200) {
    throw new Error(`kev.serve answered ${answer.status}`);
  }
  await save("kev-serve-answer.json", answer.text);
}
console.log(`spent $${spent.toFixed(6)}`);
