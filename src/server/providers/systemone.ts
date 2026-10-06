// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readStream } from "../lib/body.ts";
import { messageOf } from "../lib/errors.ts";
import { OPENROUTER_HEADERS } from "./openrouter.ts";
import { keyOf, noKeyFile, type ProviderDeps, scrubKey } from "./provider.ts";
import type { ProviderRow } from "./store.ts";
import { authHeaders, endpoint } from "./wires.ts";

// far past any answer: what is dropped unread past it
const MAX_DECISION_BYTES = 1024 * 1024;
// enough of an error body to find the question it names
const MAX_ERROR_BYTES = 64 * 1024;

export type DecisionQuestion =
  // each option with its description, or null for none
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  // the levels, lowest first
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: string };

export type DecisionRequest = {
  model: string;
  state: string;
  questions: Record<string, DecisionQuestion>;
};

// pick is the option, the level, or yes as true; probability the
// chance of pick; probabilities every option's, level's, or yes and no
export type DecisionAnswer =
  | {
      type: "choice" | "score";
      probabilities: Record<string, number>;
      pick: string;
      probability: number;
    }
  | {
      type: "noul";
      probabilities: Record<string, number>;
      pick: boolean;
      probability: number;
    };

// null where the server did not say
export type DecisionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  // USD
  cost: number | null;
};

export type Decisions = {
  // the build that answered, as the server named it, else the model asked
  served: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
};

// what a server that answered charged, when its answers were refused
export type Charged = { served: string; usage: DecisionUsage };

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly charged: Charged | null = null,
  ) {
    super(message);
  }
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

// what a sum may stray from 1: the recorded answers stray far less
export const SUM_TOLERANCE = 0.02;

const own = (o: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(o, key) ? o[key] : undefined;

// keys pairs each wire key with its name; the answer is read by keys
// when it has them all, else by names, never a mix of the two
function probabilities(
  id: string,
  raw: unknown,
  keys: [string, string][],
): Record<string, number> {
  if (keys.length === 0) {
    throw new DecisionError(`the question ${id} has no options`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new DecisionError(`the answer to ${id} has no probabilities`);
  }
  const given = raw as Record<string, unknown>;
  const has = (i: 0 | 1) => keys.filter((k) => Object.hasOwn(given, k[i]));
  const byName = has(0).length < keys.length && has(1).length > has(0).length;
  const out: Record<string, number> = Object.create(null);
  let sum = 0;
  for (const [key, name] of keys) {
    const p = own(given, byName ? name : key);
    if (!isProbability(p)) {
      throw new DecisionError(
        `the answer to ${id} has no probability for ${name}`,
      );
    }
    out[name] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new DecisionError(`the probabilities for ${id} do not sum to 1`);
  }
  return out;
}

// the first of the highest, so a tie goes to the earlier option
function highest(p: Record<string, number>): string {
  let best = "";
  let at = -1;
  for (const [name, value] of Object.entries(p)) {
    if (value > at) {
      best = name;
      at = value;
    }
  }
  return best;
}

function answerOf(
  id: string,
  question: DecisionQuestion,
  raw: unknown,
): DecisionAnswer {
  if (typeof raw !== "object" || raw === null) {
    throw new DecisionError(`the answer has no ${id}`);
  }
  const a = raw as Record<string, unknown>;
  if (a.type !== undefined && a.type !== question.type) {
    throw new DecisionError(`the answer to ${id} is not a ${question.type}`);
  }
  if (question.type === "noul") {
    if (!isProbability(a.noul)) {
      throw new DecisionError(`the answer to ${id} has no probability`);
    }
    const yes = a.noul;
    const pick = yes >= 0.5;
    return {
      type: "noul",
      probabilities: { yes, no: 1 - yes },
      pick,
      probability: pick ? yes : 1 - yes,
    };
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const p = probabilities(
      id,
      a.probabilities,
      options.map((o) => [o, o]),
    );
    const pick =
      typeof a.choice === "string" && Object.hasOwn(p, a.choice)
        ? a.choice
        : highest(p);
    return { type: "choice", probabilities: p, pick, probability: p[pick]! };
  }
  // a score's probabilities are keyed by the level's index
  const p = probabilities(
    id,
    a.probabilities,
    question.criteria.map((level, i) => [String(i), level]),
  );
  const pick = highest(p);
  return { type: "score", probabilities: p, pick, probability: p[pick]! };
}

export function parseDecisions(
  body: unknown,
  asked: DecisionRequest,
): Decisions {
  if (typeof body !== "object" || body === null) {
    throw new DecisionError("the answer is not an object");
  }
  const b = body as Record<string, unknown>;
  const given = (
    typeof b.answers === "object" && b.answers !== null ? b.answers : {}
  ) as Record<string, unknown>;
  const u = (
    typeof b.usage === "object" && b.usage !== null ? b.usage : {}
  ) as Record<string, unknown>;
  const served =
    typeof b.model === "string" && b.model !== "" ? b.model : asked.model;
  const usage = {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cost: count(u.cost),
  };
  const answers: Record<string, DecisionAnswer> = Object.create(null);
  try {
    for (const [id, question] of Object.entries(asked.questions)) {
      answers[id] = answerOf(id, question, own(given, id));
    }
  } catch (err) {
    // the server answered and charged, so the caller still counts it
    if (err instanceof DecisionError) {
      throw new DecisionError(err.message, { served, usage });
    }
    throw err;
  }
  return { served, answers, usage };
}

// the refused question, when the body names one that was asked; the
// rest of the body is never repeated
export function refusedQuestion(
  text: string,
  asked: DecisionRequest,
): string | null {
  for (const match of text.matchAll(/\bquestion\W{1,3}([\w.:-]+)/g)) {
    const id = match[1]!;
    if (Object.hasOwn(asked.questions, id)) return id;
  }
  return null;
}

function decisionError(
  name: string,
  status: number,
  text: string,
  asked: DecisionRequest,
): DecisionError {
  const question = refusedQuestion(text, asked);
  return new DecisionError(
    question === null
      ? `${name} answered ${status}`
      : `${name} answered ${status} for question ${question}`,
  );
}

async function capped(
  res: Response,
  max: number,
  signal: AbortSignal,
): Promise<string> {
  const bytes = await readStream(res.body, max, signal);
  if (bytes === null) throw new DecisionError("the answer is too large");
  return new TextDecoder().decode(bytes);
}

async function send(
  row: ProviderRow,
  deps: ProviderDeps,
  key: string | null,
  req: DecisionRequest,
  signal: AbortSignal,
): Promise<Decisions> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(row.wire === "openrouter" ? OPENROUTER_HEADERS : {}),
    ...authHeaders(row.wire, key),
  };
  const res = await deps.fetcher(endpoint(row.baseUrl, "/systemone"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: req.model,
      state: req.state,
      questions: req.questions,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await capped(res, MAX_ERROR_BYTES, signal).catch(() => "");
    throw decisionError(row.name, res.status, text, req);
  }
  let body: unknown;
  const text = await capped(res, MAX_DECISION_BYTES, signal);
  try {
    body = JSON.parse(text);
  } catch {
    throw new DecisionError(`${row.name} did not answer with JSON`);
  }
  return parseDecisions(body, req);
}

// one request; every failure is a DecisionError with the key scrubbed
export async function requestDecisions(
  row: ProviderRow,
  deps: ProviderDeps,
  req: DecisionRequest,
  signal: AbortSignal,
): Promise<Decisions> {
  const key = keyOf(row, deps.secret);
  if (row.keyName !== null && key === null) {
    throw new DecisionError(noKeyFile(row));
  }
  const scrub = (message: string) => scrubKey(message, key);
  try {
    return await send(row, deps, key, req, signal);
  } catch (err) {
    if (err instanceof DecisionError) {
      throw new DecisionError(scrub(err.message), err.charged);
    }
    if (signal.aborted) {
      const timeout =
        signal.reason instanceof DOMException &&
        signal.reason.name === "TimeoutError";
      throw new DecisionError(
        timeout
          ? `${row.name} did not answer in time`
          : `the request to ${row.name} was stopped`,
      );
    }
    throw new DecisionError(
      scrub(`${row.name} did not answer: ${messageOf(err)}`),
    );
  }
}
