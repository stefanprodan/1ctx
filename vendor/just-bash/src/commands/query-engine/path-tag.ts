/**
 * (1ctx yq) A result's path from the root, kept as its parent's tag and the
 * keys below it, and spelled out only when read: a whole path on every
 * result cost results times depth, `[..]` over a deep document gigabytes.
 */
export interface PathTag {
  readonly up: PathTag | undefined;
  readonly keys: readonly (string | number)[];
}

export const ROOT_PATH: PathTag = { up: undefined, keys: [] };

/** The tag of the node at `keys` below the one tagged `up`. */
export function pathUnder(
  up: PathTag,
  keys: readonly (string | number)[],
): PathTag {
  return keys.length === 0 ? up : { up, keys };
}

/** The path a tag stands for, from the root. */
export function pathKeys(tag: PathTag): (string | number)[] {
  const parts: (readonly (string | number)[])[] = [];
  for (let at: PathTag | undefined = tag; at; at = at.up) parts.push(at.keys);
  const path: (string | number)[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    for (const key of parts[i]) path.push(key);
  }
  return path;
}

/** The last key of a tag's path, without spelling the path out. */
export function lastPathKey(tag: PathTag): string | number | undefined {
  for (let at: PathTag | undefined = tag; at; at = at.up) {
    if (at.keys.length > 0) return at.keys[at.keys.length - 1];
  }
  return undefined;
}

/** Whether a tag stands for the root itself. */
export function isRootPath(tag: PathTag): boolean {
  return lastPathKey(tag) === undefined;
}
