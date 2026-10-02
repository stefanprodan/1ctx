/**
 * (1ctx readonly-errors) GNU's words for the errno a file system names in
 * its error, so a command reports the path the agent typed with them and
 * never the backend's message, whose path is the mount's own.
 */

const WORDS: Record<string, string> = Object.assign(Object.create(null), {
  EROFS: "Read-only file system",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EEXIST: "File exists",
  ENOTEMPTY: "Directory not empty",
  EXDEV: "Invalid cross-device link",
  ENOSPC: "No space left on device",
  EFBIG: "File too large",
  EBUSY: "Device or resource busy",
  ELOOP: "Too many levels of symbolic links",
});

/** The errno an error carries, from its code or its message's lead. */
export function fsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code in WORDS) return code;
  const lead = /^(E[A-Z]+):/.exec(error.message)?.[1];
  return lead !== undefined && lead in WORDS ? lead : undefined;
}

/** GNU's words for the error's errno, or undefined for another error. */
export function fsErrorWords(error: unknown): string | undefined {
  const code = fsErrorCode(error);
  return code === undefined ? undefined : WORDS[code];
}

/** Whether the error is a write refused by a read-only file system. */
export function isReadOnlyError(error: unknown): boolean {
  return fsErrorCode(error) === "EROFS";
}

/** The call a file system names after its message's comma: rm, write, ... */
export function fsErrorSyscall(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /^E[A-Z]+: [^,]*, ([a-z]+)\b/.exec(error.message)?.[1];
}

/**
 * Why a file could not be read, in GNU's words: too large for the read
 * limit, a looping link, or else missing, which is what the commands said
 * before.
 */
export function readErrorWords(error: unknown): string {
  const code = fsErrorCode(error);
  return code === "EFBIG" || code === "ELOOP"
    ? WORDS[code]
    : "No such file or directory";
}

const CREATING = new Set(["write", "append", "open", "mkdir", "symlink", "link"]);

/**
 * GNU's words for a write a file system refused: read-only, or a path that
 * cannot be made (a missing or file parent, a folder written to, a looping
 * link), as a read-only overlay reports before EROFS. Undefined for
 * anything else.
 */
export function writeRefusalWords(error: unknown): string | undefined {
  const code = fsErrorCode(error);
  if (
    code === "EROFS" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "ELOOP"
  ) {
    return fsErrorWords(error);
  }
  if (code === "ENOENT" && CREATING.has(fsErrorSyscall(error) ?? "")) {
    return fsErrorWords(error);
  }
  return undefined;
}
