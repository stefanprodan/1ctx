/**
 * Comment-keeping output for yq (1ctx yq)
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
    // several lines are a literal block, as go-yaml writes them, unless a
    // line ends in a blank or a character needs an escape (1ctx yq-documents)
    if (value.includes("\n") && !/[ \t]\n|[ \t]$|[^\t\n\x20-\x7e\u00a0-\ufffd]/u.test(value)) {
      node.type = "BLOCK_LITERAL";
    } else if (ambiguous(value)) node.type = "QUOTE_DOUBLE";
    return node;
  }
  const node = new YAML.Scalar(
    value === null
      ? "null"
      : typeof value === "number"
        ? (spelled(value) ?? numberText(value))
        : String(value),
  );
  node.type = "PLAIN";
  return node;
}

// A number the document spells so a YAML 1.1 reader reads it otherwise
// (`0644`, octal there): a copy of it keeps that spelling, as mikefarah
// copies the node, where `644` changed a file mode (1ctx yq-documents)
let numbers: {
  doc: YAML.Document;
  literals?: Map<number, string>;
  spellings?: Map<number, string>;
  /** the spellings of nodes the edit deleted, so a moved value keeps its own */
  removed?: Map<number, string>;
} | null = null;

// every number under `node` a YAML 1.1 reader reads otherwise, into `into`
function collectSpellings(node: unknown, into: Map<number, string>): void {
  YAML.visit(node as YAML.Node, {
    Scalar(_, scalar) {
      if (scalar.type !== "PLAIN" || typeof scalar.value !== "string") return;
      const text = scalar.value;
      const read = YAML.parse(text);
      if (typeof read === "number" && YAML.parse(text, { version: "1.1" }) !== read) {
        into.set(read, text);
      }
    },
  });
}

function spelled(value: number): string | undefined {
  if (!numbers) return undefined;
  // a number the filter wrote keeps its spelling, `.mode = 0600`
  const literal = numbers.literals?.get(value);
  if (literal !== undefined) return literal;
  if (!numbers.spellings) {
    numbers.spellings = new Map<number, string>();
    collectSpellings(numbers.doc, numbers.spellings);
  }
  return numbers.spellings.get(value) ?? numbers.removed?.get(value);
}

// a node about to be deleted or overwritten: its spellings stay known for
// a value moved from it (`.mode = .defaultMode | del(.defaultMode)`), as
// mikefarah's node carries its own (1ctx yq-documents)
function forget(doc: YAML.Document, path: Key[]): void {
  if (!numbers || numbers.spellings) return;
  const node = doc.getIn(path, true);
  if (YAML.isNode(node)) {
    numbers.removed ??= new Map<number, string>();
    collectSpellings(node, numbers.removed);
  }
}

function deleteAt(doc: YAML.Document, path: Key[]): void {
  forget(doc, path);
  doc.deleteIn(path);
}

// The document an edit is applied to and the values it was read as, so a
// map or list the filter copied from it (`.items += [.items[0]]`,
// `{"x": .}`) is written as its node, spelling and comments kept, as
// mikefarah copies nodes; rebuilt from values, `0644` became `644`
// (1ctx yq-documents)
let source: { doc: YAML.Document; index: Map<object, Key[]> } | null = null;

/**
 * Where each map and list of `before` sits, when `after` holds one of them
 * somewhere else; null when nothing was copied, the usual edit, which then
 * costs no copy of the document.
 */
function copiesOf(before: QueryValue, after: QueryValue): Map<object, Key[]> | null {
  const index = new Map<object, Key[]>();
  const walk = (v: QueryValue, at: Key[]) => {
    if (v === null || typeof v !== "object" || index.has(v)) return;
    index.set(v, at);
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, [...at, i]));
    else for (const [key, item] of Object.entries(v)) walk(item, [...at, key]);
  };
  walk(before, []);
  const moved = (v: QueryValue, at: Key[]): boolean => {
    if (v === null || typeof v !== "object") return false;
    const was = index.get(v);
    // a map or list left where it was holds nothing copied
    if (was) return !same(was, at);
    if (Array.isArray(v)) return v.some((item, i) => moved(item, [...at, i]));
    return Object.entries(v).some(([key, item]) => moved(item, [...at, key]));
  };
  return moved(after, []) ? index : null;
}

function copied(value: object): YAML.Node | null {
  const at = source?.index.get(value);
  if (!source || !at) return null;
  const node = at.length === 0 ? source.doc.contents : source.doc.getIn(at, true);
  if (!YAML.isCollection(node)) return null;
  const clone = node.clone() as YAML.Node;
  // it must still read as the value, aliases and all
  const doc = new YAML.Document(undefined, { schema: "failsafe" });
  doc.contents = clone as typeof doc.contents;
  return same(YAML.parse(doc.toString(), { merge: true }), value) ? clone : null;
}

function build(value: QueryValue): YAML.Node {
  if (value !== null && typeof value === "object") {
    const node = copied(value);
    if (node) return node;
  }
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
  forget(doc, path);
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
        deleteAt(doc, [...path, key]);
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
    const kept = Object.keys(was).filter((key) => Object.hasOwn(now, key));
    const added = Object.keys(now).filter((key) => !Object.hasOwn(was, key));
    if (!same([...kept, ...added], Object.keys(now))) {
      // keys in another order (sort_keys): the pairs follow, each with its
      // comments, where the whole document was written afresh without
      // them; the check confirms it (1ctx yq-documents)
      const order = new Map(Object.keys(now).map((key, i) => [key, i]));
      const name = (pair: YAML.Pair) =>
        String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
      if (
        YAML.isMap(parent) &&
        parent.items.every((pair) => order.has(name(pair as YAML.Pair)))
      ) {
        parent.items.sort(
          (a, b) =>
            (order.get(name(a as YAML.Pair)) as number) -
            (order.get(name(b as YAML.Pair)) as number),
        );
      }
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
      deleteAt(doc, [...path, i]);
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
  /** numbers the filter wrote, as written: 0600 (1ctx yq-documents) */
  literals?: Map<number, string>;
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

const DEFAULT_TAGS: Record<string, string> = {
  "!": "!",
  "!!": "tag:yaml.org,2002:",
};

/** Whether a document declares a tag handle of its own with %TAG. */
export function hasTagDirective(doc: YAML.Document): boolean {
  const tags = doc.directives?.tags ?? {};
  return Object.entries(tags).some(
    ([handle, prefix]) => DEFAULT_TAGS[handle] !== prefix,
  );
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
    // mikefarah writes no %TAG: a tag of one is spelled out in full, and
    // the document's --- goes with it (1ctx yq-documents)
    const tagged = hasTagDirective(copy);
    if (tagged && copy.directives) {
      copy.directives.tags = { ...DEFAULT_TAGS };
      copy.directives.docStart = null;
    }
    const touched: Touch[] = [];
    const index = copiesOf(before, after);
    source = index ? { doc: copy.clone(), index } : null;
    numbers = { doc: source?.doc ?? copy, literals: spelling.literals };
    try {
      applyChanges(copy, [], before, after, touched);
    } finally {
      source = null;
      numbers = null;
    }
    // a merge key is written tagged, as mikefarah writes it (1ctx yq-anchors)
    YAML.visit(copy, {
      Pair(_, pair) {
        if (YAML.isScalar(pair.key) && pair.key.value === "<<") {
          pair.key.tag = "tag:yaml.org,2002:merge";
        }
      },
    });
    if (spelling.stripComments) stripComments(copy);
    if (spelling.pretty && copy.contents) prettify(copy.contents);
    let text = copy
      .toString({
        flowCollectionPadding: false,
        indent: spelling.indent ?? 2,
        indentSeq: true,
      })
      .replace(/^---\n/, "")
      .replace(/\n+$/, "")
      // mikefarah writes no closing ... (1ctx yq-documents)
      .replace(/\n\.\.\.$/, "")
      // a head comment sits on the line above, as mikefarah writes it
      .replace(/^((?:#[^\n]*\n)+)\n/, "$1")
      // a foot comment follows the last line, as mikefarah writes it
      .replace(/\n\n(?=(#[^\n]*\n?)+$)/, "\n");
    if (tagged) text = text.replace(/^((?:%[^\n]*\n)*)---\n/, "$1");
    // what is written must read back as the result: the nodes the edit
    // wrote, or the whole text where an anchor or a merge key could
    // reach past them (merge keys read merged, as the values were)
    if (touched.length === 0) return text;
    if (!/[&*]|<<:/.test(text)) {
      return readsBack(copy, after, touched) ? text : null;
    }
    // with anchors the text must still read, and each place the edit
    // wrote must read as written; a place an alias or a merge key shares
    // shows the edit, as mikefarah's aliases are references, where the
    // whole document was held to our copies and the edit refused
    // (1ctx yq-anchors)
    const reread = YAML.parseDocument(text, { merge: true });
    if (reread.errors.length > 0) return null;
    const read = reread.toJS({ maxAliasCount: 100 }) as QueryValue;
    for (const { path, whole } of touched) {
      // a key a merge key brings back reads again where it was dropped
      if (whole && !same(valueAt(read, path), valueAt(after, path))) {
        return null;
      }
    }
    return text;
  } catch {
    return null;
  }
}
