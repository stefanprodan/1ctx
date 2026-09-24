/**
 * File types for rg's -t, -T, --type-add, --type-clear and --type-list.
 *
 * (1ctx) ripgrep 15's whole table, from file-types-data.ts, each type a
 * list of globs matched case-sensitively against a file's name, as the
 * ignore crate matches them.
 */

import { createUserRegex, type RegexLike } from "../../regex/index.js";
import { RIPGREP_TYPES } from "./file-types-data.js";
import { GlobError, globSource } from "./globs.js";

/** ripgrep's refusal of a type or a definition, exit 2. */
export class FileTypeError extends Error {}

const INVALID = "invalid definition (format is type:glob, e.g., html:*.html)";
const NAME = /^[\p{L}\p{N}]+$/u;

/**
 * Mutable file type registry for runtime type modifications
 * Supports --type-add and --type-clear flags
 */
export class FileTypeRegistry {
  private readonly types = new Map<string, string[]>();
  private readonly compiled = new Map<string, RegexLike | null>();

  constructor() {
    for (const [name, globs] of Object.entries(RIPGREP_TYPES)) {
      this.types.set(name, [...globs]);
    }
  }

  /** `name:glob`, or `name:include:a,b` for the globs of other types. */
  addType(spec: string): void {
    const colon = spec.indexOf(":");
    const name = colon < 0 ? "" : spec.slice(0, colon);
    const rest = colon < 0 ? "" : spec.slice(colon + 1);
    if (!NAME.test(name) || rest === "") throw new FileTypeError(INVALID);
    const globs = this.types.get(name) ?? [];
    if (rest.startsWith("include:")) {
      const names = rest.slice("include:".length).split(",");
      for (const other of names) {
        const included = this.types.get(other);
        if (other === "" || included === undefined) {
          throw new FileTypeError(INVALID);
        }
        globs.push(...included);
      }
    } else {
      try {
        globSource(rest);
      } catch (error) {
        if (!(error instanceof GlobError)) throw error;
        throw new FileTypeError(`error parsing glob '${rest}': ${error.message}`);
      }
      globs.push(rest);
    }
    this.types.set(name, [...new Set(globs)]);
    this.compiled.delete(name);
  }

  /** A type that is not there is no error, as in ripgrep. */
  clearType(name: string): void {
    if (!this.types.has(name)) return;
    this.types.set(name, []);
    this.compiled.delete(name);
  }

  getType(name: string): string[] | undefined {
    return this.types.get(name);
  }

  /** ripgrep's error for a -t or -T naming no type. */
  check(names: string[]): void {
    for (const name of names) {
      if (name !== "all" && !this.types.has(name)) {
        throw new FileTypeError(`unrecognized file type: ${name}`);
      }
    }
  }

  private regex(name: string): RegexLike | null {
    let regex = this.compiled.get(name);
    if (regex !== undefined) return regex;
    const globs = this.types.get(name) ?? [];
    regex =
      globs.length === 0
        ? null
        : createUserRegex(
            `^(?:${globs.map((glob) => globSource(glob)).join("|")})$`,
          );
    this.compiled.set(name, regex);
    return regex;
  }

  /** Whether a file's name has one of the types; `all` is any type. */
  matchesType(filename: string, typeNames: string[]): boolean {
    for (const typeName of typeNames) {
      const names = typeName === "all" ? [...this.types.keys()] : [typeName];
      for (const name of names) {
        if (this.regex(name)?.test(filename)) return true;
      }
    }
    return false;
  }

  /** --type-list: every type with globs, its globs sorted. */
  format(): string {
    const lines: string[] = [];
    for (const name of [...this.types.keys()].sort()) {
      const globs = [...(this.types.get(name) ?? [])].sort();
      if (globs.length > 0) lines.push(`${name}: ${globs.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
