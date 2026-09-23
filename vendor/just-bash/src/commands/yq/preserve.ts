/**
 * Comment-keeping writes for yq -i (1ctx)
 *
 * The query engine works on plain values, so a document printed from its
 * result loses every comment, and `yq -i` on a commented manifest deleted
 * the team's notes. Like mikefarah's yq, an in-place edit keeps them: the
 * change between a document's value and the filter's result is applied to
 * the document parsed with the failsafe schema, where every scalar is its
 * source text, so untouched nodes keep their comments, quoting and exact
 * spelling (0644 stays 0644, yes stays yes). Only values the filter wrote
 * are spelled here, quoted when a YAML 1.1 reader would retype them. The
 * patched document must read back as exactly the result, keys in order,
 * or the caller prints the result plainly instead.
 */

import YAML from "yaml";
import type { QueryValue } from "../query-engine/index.js";
import { asQueryRecord } from "../query-engine/safe-object.js";

type Key = string | number;

function isMap(v: QueryValue): v is Record<string, QueryValue> {
  return asQueryRecord(v) !== null;
}

// undefined reads as null, as it prints
function same(a: QueryValue, b: QueryValue): boolean {
  const text = (v: QueryValue) =>
    JSON.stringify(v, (_, x) => (x === undefined ? null : x));
  return text(a) === text(b);
}

// a string a YAML 1.2 or a YAML 1.1 reader (Kubernetes) would read as
// something else when written plain: yes, 0644, 1_000, 2001-12-14, ~
function ambiguous(text: string): boolean {
  if (text === "") return true;
  for (const version of ["1.2", "1.1"] as const) {
    try {
      if (YAML.parse(text, { version }) !== text) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function numberText(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (value === Number.POSITIVE_INFINITY) return ".inf";
  if (value === Number.NEGATIVE_INFINITY) return "-.inf";
  return String(value);
}

// A value the filter wrote, as a node of the failsafe document: every
// scalar is text there, so its style decides how a reader types it.
function scalar(value: QueryValue): YAML.Scalar {
  if (typeof value === "string") {
    const node = new YAML.Scalar(value);
    if (ambiguous(value)) node.type = "QUOTE_DOUBLE";
    return node;
  }
  const node = new YAML.Scalar(
    value === null
      ? "null"
      : typeof value === "number"
        ? numberText(value)
        : String(value),
  );
  node.type = "PLAIN";
  return node;
}

function build(value: QueryValue): YAML.Node {
  if (Array.isArray(value)) {
    const seq = new YAML.YAMLSeq();
    for (const item of value) seq.items.push(build(item));
    return seq;
  }
  if (isMap(value)) {
    const map = new YAML.YAMLMap();
    for (const [key, item] of Object.entries(value)) {
      map.items.push(new YAML.Pair(scalar(key), build(item)));
    }
    return map;
  }
  return scalar(value);
}

// an edited scalar keeps its node, and so its comment
function put(doc: YAML.Document, path: Key[], value: QueryValue): void {
  const current = doc.getIn(path, true);
  if (YAML.isScalar(current) && !isMap(value) && !Array.isArray(value)) {
    const next = scalar(value);
    current.value = next.value;
    current.type = next.type;
    current.tag = undefined;
    return;
  }
  doc.setIn(path, build(value));
}

function applyChanges(
  doc: YAML.Document,
  path: Key[],
  before: QueryValue,
  after: QueryValue,
): void {
  if (same(before, after)) return;
  const bothMaps = isMap(before) && isMap(after);
  const bothSeqs = Array.isArray(before) && Array.isArray(after);
  if (path.length === 0 && !bothMaps && !bothSeqs) {
    doc.contents = build(after) as typeof doc.contents;
    return;
  }
  if (bothMaps) {
    const was = before as Record<string, QueryValue>;
    const now = after as Record<string, QueryValue>;
    for (const key of Object.keys(was)) {
      if (!Object.hasOwn(now, key)) doc.deleteIn([...path, key]);
    }
    const parent = path.length === 0 ? doc.contents : doc.getIn(path, true);
    for (const key of Object.keys(now)) {
      if (Object.hasOwn(was, key)) {
        applyChanges(doc, [...path, key], was[key], now[key]);
      } else if (YAML.isMap(parent)) {
        parent.items.push(new YAML.Pair(scalar(key), build(now[key])));
      } else {
        throw new Error("not a map");
      }
    }
    return;
  }
  if (bothSeqs) {
    const was = before as QueryValue[];
    const now = after as QueryValue[];
    const common = Math.min(was.length, now.length);
    for (let i = 0; i < common; i++) {
      applyChanges(doc, [...path, i], was[i], now[i]);
    }
    for (let i = was.length - 1; i >= now.length; i--) {
      doc.deleteIn([...path, i]);
    }
    for (let i = was.length; i < now.length; i++) {
      doc.addIn(path, build(now[i]));
    }
    return;
  }
  put(doc, path, after);
}

/**
 * Whether a plain scalar of the document reads differently for a YAML 1.1
 * reader (Kubernetes) than for YAML 1.2: 0644, yes, 1_000. Writing such a
 * document afresh from values would change what the 1.1 reader gets.
 */
export function spelledFor11(doc: YAML.Document): boolean {
  let found = false;
  YAML.visit(doc, {
    Scalar(_, node) {
      if (node.type !== "PLAIN" || typeof node.value !== "string") return;
      const text = node.value;
      // a merge key, which a fresh 1.1 spelling quotes into a plain key
      if (text === "<<") {
        found = true;
        return YAML.visit.BREAK;
      }
      let a: unknown;
      let b: unknown;
      try {
        a = YAML.parse(text, { version: "1.1" });
        b = YAML.parse(text, { version: "1.2" });
      } catch {
        return;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        found = true;
        return YAML.visit.BREAK;
      }
    },
  });
  return found;
}

/** Whether the document holds an alias, which a fresh spelling expands. */
export function hasAlias(doc: YAML.Document): boolean {
  let found = false;
  YAML.visit(doc, {
    Alias() {
      found = true;
      return YAML.visit.BREAK;
    },
  });
  return found;
}

/**
 * The document's text with `after` in place of `before`, its comments and
 * every untouched scalar kept as written, or null when the edit cannot be
 * carried over faithfully. `doc` is parsed with the failsafe schema.
 */
export function preservingText(
  doc: YAML.Document,
  before: QueryValue,
  after: QueryValue,
): string | null {
  if (!(isMap(after) || Array.isArray(after))) return null;
  const copy = doc.clone();
  try {
    applyChanges(copy, [], before, after);
    const text = copy
      .toString({ flowCollectionPadding: false })
      .replace(/\n+$/, "");
    // what is written must read back as the result
    // merge keys read merged, as the values were (1ctx)
    const reread = YAML.parseDocument(text, { merge: true });
    if (reread.errors.length > 0) return null;
    if (!same(reread.toJS({ maxAliasCount: 100 }) as QueryValue, after)) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
