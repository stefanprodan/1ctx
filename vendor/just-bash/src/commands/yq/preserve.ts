/**
 * Comment-keeping writes for yq -i (1ctx)
 *
 * The query engine works on plain values, so a document printed from its
 * result loses every comment, and `yq -i` on a commented manifest deleted
 * the team's notes. Like mikefarah's yq, an in-place edit keeps them: the
 * change between a document's value and the filter's result is applied to
 * the parsed document, so untouched nodes keep their comments, quoting and
 * style. The patched document must read back as exactly the result, keys in
 * order, or the caller prints the result plainly instead.
 */

import YAML from "yaml";
import type { QueryValue } from "../query-engine/index.js";
import { asQueryRecord } from "../query-engine/safe-object.js";

type Key = string | number;

function isMap(v: QueryValue): v is Record<string, QueryValue> {
  return asQueryRecord(v) !== null;
}

function same(a: QueryValue, b: QueryValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyChanges(
  doc: YAML.Document,
  path: Key[],
  before: QueryValue,
  after: QueryValue,
): void {
  if (same(before, after)) return;
  if (path.length === 0 && !(isMap(before) && isMap(after))) {
    if (!(Array.isArray(before) && Array.isArray(after))) {
      doc.contents = doc.createNode(after) as typeof doc.contents;
      return;
    }
  }
  if (isMap(before) && isMap(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) doc.deleteIn([...path, key]);
    }
    for (const key of Object.keys(after)) {
      if (Object.hasOwn(before, key)) {
        applyChanges(doc, [...path, key], before[key], after[key]);
      } else {
        doc.setIn([...path, key], after[key]);
      }
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const common = Math.min(before.length, after.length);
    for (let i = 0; i < common; i++) {
      applyChanges(doc, [...path, i], before[i], after[i]);
    }
    for (let i = before.length - 1; i >= after.length; i--) {
      doc.deleteIn([...path, i]);
    }
    for (let i = before.length; i < after.length; i++) {
      doc.addIn(path, after[i]);
    }
    return;
  }
  doc.setIn(path, after);
}

/**
 * The document's text with `after` in place of `before`, its comments kept,
 * or null when the edit cannot be carried over faithfully.
 */
export function preservingText(
  doc: YAML.Document,
  before: QueryValue,
  after: QueryValue,
): string | null {
  if (!(isMap(after) || Array.isArray(after))) return null;
  // a key the engine saw as a string but YAML typed (1: one) would be
  // written beside the original instead of over it
  let typedKey = false;
  YAML.visit(doc, {
    Pair(_, pair) {
      if (YAML.isScalar(pair.key) && typeof pair.key.value !== "string") {
        typedKey = true;
        return YAML.visit.BREAK;
      }
    },
  });
  if (typedKey) return null;
  const copy = doc.clone();
  try {
    applyChanges(copy, [], before, after);
    const text = copy
      .toString({ flowCollectionPadding: false })
      .replace(/\n+$/, "");
    // what is written must read back as the result: a kept tag (!!str on a
    // number set in its place) would not
    const reread = YAML.parseDocument(text);
    if (reread.errors.length > 0) return null;
    if (!same(reread.toJS({ maxAliasCount: 100 }) as QueryValue, after)) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
