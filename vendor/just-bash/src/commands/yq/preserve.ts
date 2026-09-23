/**
 * Comment-keeping output for yq (1ctx)
 *
 * The query engine works on plain values, so a document printed from its
 * result loses every comment, and `yq -i` on a commented manifest deleted
 * the team's notes. Like mikefarah's yq, an in-place edit and a result
 * printed from a node of the document keep them: the
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

/** A node the edit wrote (whole) or a collection it took items from. */
interface Touch {
  path: Key[];
  whole: boolean;
}

// an edited scalar keeps its node, and so its comment, and a quoted one
// its quotes for a string, as mikefarah keeps the node's style
function put(
  doc: YAML.Document,
  path: Key[],
  value: QueryValue,
  touched: Touch[],
): void {
  touched.push({ path, whole: true });
  const current = doc.getIn(path, true);
  if (YAML.isScalar(current) && !isMap(value) && !Array.isArray(value)) {
    const next = scalar(value);
    const quoted =
      current.type === "QUOTE_DOUBLE" || current.type === "QUOTE_SINGLE";
    current.value = next.value;
    current.type =
      typeof value === "string" && quoted && !value.includes("\n")
        ? current.type
        : next.type;
    current.tag = undefined;
    return;
  }
  doc.setIn(path, build(value));
}

// items moved, none changed: the nodes follow their items
function reordered(
  seq: YAML.YAMLSeq,
  was: QueryValue[],
  now: QueryValue[],
): boolean {
  if (was.length !== now.length || seq.items.length !== was.length) {
    return false;
  }
  const texts = new Map<string, number[]>();
  const text = (v: QueryValue) =>
    JSON.stringify(v, (_, x) => (x === undefined ? null : x));
  was.forEach((item, i) => {
    const key = text(item);
    texts.set(key, [...(texts.get(key) ?? []), i]);
  });
  const order: number[] = [];
  for (const item of now) {
    const free = texts.get(text(item));
    const index = free?.shift();
    if (index === undefined) return false;
    order.push(index);
  }
  if (order.every((index, i) => index === i)) return false;
  seq.items = order.map((index) => seq.items[index]);
  return true;
}

// every node the edit wrote goes into touched, so only those are read
// back to check them
function applyChanges(
  doc: YAML.Document,
  path: Key[],
  before: QueryValue,
  after: QueryValue,
  touched: Touch[],
): void {
  if (same(before, after)) return;
  const bothMaps = isMap(before) && isMap(after);
  const bothSeqs = Array.isArray(before) && Array.isArray(after);
  if (path.length === 0 && !bothMaps && !bothSeqs) {
    doc.contents = build(after) as typeof doc.contents;
    touched.push({ path, whole: true });
    return;
  }
  if (bothMaps) {
    const was = before as Record<string, QueryValue>;
    const now = after as Record<string, QueryValue>;
    const parent = path.length === 0 ? doc.contents : doc.getIn(path, true);
    // a head comment stays at the head when its key goes
    const head = YAML.isMap(parent) ? parent.items[0]?.key : undefined;
    const headComment = YAML.isNode(head) ? head.commentBefore : undefined;
    for (const key of Object.keys(was)) {
      if (!Object.hasOwn(now, key)) {
        doc.deleteIn([...path, key]);
        touched.push({ path, whole: false });
      }
    }
    if (
      headComment &&
      YAML.isMap(parent) &&
      parent.items[0]?.key !== head
    ) {
      const next = parent.items[0]?.key;
      if (YAML.isNode(next)) {
        next.commentBefore = next.commentBefore
          ? `${headComment}\n${next.commentBefore}`
          : headComment;
      } else if (path.length === 0) {
        doc.commentBefore = headComment;
      }
    }
    for (const key of Object.keys(now)) {
      if (Object.hasOwn(was, key)) {
        applyChanges(doc, [...path, key], was[key], now[key], touched);
      } else if (YAML.isMap(parent)) {
        parent.items.push(new YAML.Pair(scalar(key), build(now[key])));
        touched.push({ path: [...path, key], whole: true });
      } else {
        throw new Error("not a map");
      }
    }
    // keys in another order are not carried over: the check says so
    const kept = Object.keys(was).filter((key) => Object.hasOwn(now, key));
    const added = Object.keys(now).filter((key) => !Object.hasOwn(was, key));
    if (!same([...kept, ...added], Object.keys(now))) {
      touched.push({ path, whole: false });
    }
    return;
  }
  if (bothSeqs) {
    const was = before as QueryValue[];
    const now = after as QueryValue[];
    // the same items in another order keep their nodes: sort, reverse
    const seq = path.length === 0 ? doc.contents : doc.getIn(path, true);
    if (YAML.isSeq(seq) && reordered(seq, was, now)) {
      touched.push({ path, whole: false });
      return;
    }
    const common = Math.min(was.length, now.length);
    for (let i = 0; i < common; i++) {
      applyChanges(doc, [...path, i], was[i], now[i], touched);
    }
    for (let i = was.length - 1; i >= now.length; i--) {
      doc.deleteIn([...path, i]);
      touched.push({ path, whole: false });
    }
    for (let i = was.length; i < now.length; i++) {
      doc.addIn(path, build(now[i]));
      touched.push({ path: [...path, i], whole: true });
    }
    return;
  }
  put(doc, path, after, touched);
}

function valueAt(value: QueryValue, path: Key[]): QueryValue {
  let at = value;
  for (const step of path) {
    if (Array.isArray(at)) at = at[step as number] ?? null;
    else if (isMap(at)) at = at[step as string] ?? null;
    else return null;
  }
  return at;
}

// the text of one node of a failsafe document
function nodeText(node: YAML.Node): string {
  const doc = new YAML.Document(undefined, { schema: "failsafe" });
  doc.contents = node as typeof doc.contents;
  return doc.toString({ flowCollectionPadding: false });
}

// whether every node the edit wrote reads back as the result, and every
// collection it took items from has the result's keys or length, so a
// large document costs its edit and not a second parse
function readsBack(
  doc: YAML.Document,
  after: QueryValue,
  touched: Touch[],
): boolean {
  for (const { path, whole } of touched) {
    const node = doc.getIn(path, true);
    const want = valueAt(after, path);
    if (whole) {
      if (!YAML.isNode(node)) return false;
      const reread = YAML.parseDocument(nodeText(node), { merge: true });
      if (reread.errors.length > 0) return false;
      if (!same(reread.toJS({ maxAliasCount: 100 }) as QueryValue, want)) {
        return false;
      }
    } else if (YAML.isMap(node)) {
      if (!isMap(want)) return false;
      const keys = node.items.map((pair) =>
        YAML.isScalar(pair.key) ? String(pair.key.value) : "",
      );
      if (!same(keys, Object.keys(want))) return false;
    } else if (YAML.isSeq(node)) {
      if (!Array.isArray(want) || node.items.length !== want.length) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
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

/** How a kept node is spelled: mikefarah's -I and -P, `... comments=""`. */
export interface Spelling {
  indent?: number;
  /** block collections and plain scalars where the text allows */
  pretty?: boolean;
  /** every comment dropped, the style kept */
  stripComments?: boolean;
  /** the document is the caller's to change, so it is not cloned */
  own?: boolean;
}

function stripComments(doc: YAML.Document): void {
  doc.comment = null;
  doc.commentBefore = null;
  if (!doc.contents) return;
  YAML.visit(doc.contents, {
    Node(_, node) {
      node.comment = null;
      node.commentBefore = null;
    },
    Pair(_, pair) {
      if (YAML.isNode(pair.key)) {
        pair.key.comment = null;
        pair.key.commentBefore = null;
      }
    },
  });
}

// -P: every collection in block style, every string plain that reads back
function prettify(node: YAML.Node): void {
  YAML.visit(node, {
    Map(_, map) {
      map.flow = false;
    },
    Seq(_, seq) {
      seq.flow = false;
    },
    Scalar(_, scalar) {
      if (
        typeof scalar.value === "string" &&
        scalar.type !== "PLAIN" &&
        !scalar.value.includes("\n") &&
        !ambiguous(scalar.value)
      ) {
        scalar.type = "PLAIN";
      }
    },
  });
}

/**
 * The text of the node at `path` with `after` in place of `before`, its
 * comments and every untouched scalar kept as written, or null when the
 * edit cannot be carried over faithfully. `doc` is parsed with the
 * failsafe schema; the whole document keeps its own comments too.
 */
export function preservingText(
  doc: YAML.Document,
  before: QueryValue,
  after: QueryValue,
  path: Key[] = [],
  spelling: Spelling = {},
): string | null {
  // only a node of the same kind is edited in place; anything else is
  // spelled afresh by the caller
  const bothMaps = isMap(before) && isMap(after);
  const bothSeqs = Array.isArray(before) && Array.isArray(after);
  if (!bothMaps && !bothSeqs) return null;
  try {
    let copy: YAML.Document;
    if (path.length === 0) {
      copy = spelling.own ? doc : doc.clone();
    } else {
      // the node alone, so a long stream costs each result its own size
      const node = doc.getIn(path, true);
      if (!YAML.isCollection(node)) return null;
      copy = new YAML.Document(undefined, { schema: "failsafe" });
      copy.contents = node.clone() as typeof copy.contents;
    }
    const touched: Touch[] = [];
    applyChanges(copy, [], before, after, touched);
    if (spelling.stripComments) stripComments(copy);
    if (spelling.pretty && copy.contents) prettify(copy.contents);
    const text = copy
      .toString({
        flowCollectionPadding: false,
        indent: spelling.indent ?? 2,
        indentSeq: true,
      })
      .replace(/^---\n/, "")
      .replace(/\n+$/, "")
      // a head comment sits on the line above, as mikefarah writes it
      .replace(/^((?:#[^\n]*\n)+)\n/, "$1")
      // a foot comment follows the last line, as mikefarah writes it
      .replace(/\n\n(?=(#[^\n]*\n?)+$)/, "\n");
    // what is written must read back as the result: the nodes the edit
    // wrote, or the whole text where an anchor or a merge key could
    // reach past them (merge keys read merged, as the values were)
    if (touched.length === 0) return text;
    if (!/[&*]|<<:/.test(text)) {
      return readsBack(copy, after, touched) ? text : null;
    }
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
