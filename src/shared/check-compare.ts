// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A check's Compare (docs/automations.md, The check): a dotted path into
// a JSON answer, such as tag_name or data.items[0].id, whose value alone
// decides what is new.

export const MAX_CHECK_COMPARE = 200;

export const COMPARE_REFUSAL =
  "Compare must be a dotted path like tag_name or items[0].id";
export const COMPARE_NEEDS_URL = "Compare needs a Check URL";

// a key, or an array index
export type ComparePath = (string | number)[];

// a key with its indexes; the first may be indexes alone, for an
// answer that is an array. A leading dot is jq's and ignored
const SEGMENT = /^([A-Za-z0-9_-]*)((?:\[\d{1,9}\])*)$/;

export function parseCompare(text: string): ComparePath | null {
  if (text.length > MAX_CHECK_COMPARE) return null;
  const body = text.startsWith(".") ? text.slice(1) : text;
  if (body === "") return null;
  const path: ComparePath = [];
  for (const [i, segment] of body.split(".").entries()) {
    const match = SEGMENT.exec(segment);
    if (match === null) return null;
    const [, key, indexes] = match as unknown as [string, string, string];
    if (key === "" && (i > 0 || indexes === "")) return null;
    if (key !== "") path.push(key);
    for (const index of indexes.matchAll(/\d+/g)) path.push(Number(index[0]));
  }
  return path;
}

// one spelling per path, so an equal path never clears what was seen
export function formatCompare(path: ComparePath): string {
  let out = "";
  for (const step of path) {
    if (typeof step === "number") out += `[${step}]`;
    else out += out === "" ? step : `.${step}`;
  }
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// the value at the path; undefined when the answer lacks it
export function valueAt(json: unknown, path: ComparePath): unknown {
  let value = json;
  for (const step of path) {
    if (typeof step === "number") {
      if (!Array.isArray(value) || step >= value.length) return undefined;
      value = value[step];
    } else {
      if (!isObject(value) || !Object.hasOwn(value, step)) return undefined;
      value = value[step];
    }
  }
  return value;
}

// null, "", [] and {} say nothing, as an empty body does
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

// JSON with every object's keys sorted, so a reordered object is the
// same value
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
