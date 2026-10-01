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
  EBUSY: "Device or resource busy",
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
