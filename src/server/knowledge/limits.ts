// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed budgets and command surface of a disposable knowledge mount.
// Commands are pinned so a dependency upgrade cannot silently expose a
// new runtime; the body budget leaves room for JSON escaping at the cap.

import { MAX_REQUEST_BYTES } from "../lib/body.ts";
import { LIMIT_DEFINITIONS } from "../limits/index.ts";

export const RECENT_FILES = 5;
export const KNOWLEDGE_COMMANDS_IN_FLIGHT = 4;
export const MAX_OPENS_PER_COMMAND = 10;
export const MAX_KNOWLEDGE_BODY = 3 * LIMIT_DEFINITIONS.knowledgeFileBytes.max;
export const MAX_ARCHIVE_UPLOAD = MAX_REQUEST_BYTES;
export const MAX_ARCHIVE_EXPANDED = LIMIT_DEFINITIONS.knowledgeProjectBytes.max;
export const MAX_ARCHIVE_MEMBERS = 2_000;
export const ARCHIVE_DEADLINE_MS = 60_000;
export const UPLOAD_LEASE_MS = 24 * 60 * 60 * 1_000;
export const MAX_STAGED_ITEMS = 20;

export const KNOWLEDGE_COMMANDS = [
  "ls",
  "find",
  "tree",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "gawk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "comm",
  "join",
  "paste",
  "column",
  "nl",
  "tac",
  "rev",
  "fold",
  "expand",
  "unexpand",
  "jq",
  "yq",
  "xan",
  "base64",
  "tar",
  "gzip",
  "gunzip",
  "zcat",
  "date",
  "echo",
  "printf",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "rmdir",
  "touch",
  "stat",
  "file",
  "ln",
  "basename",
  "dirname",
  "du",
  "env",
  "printenv",
  "pwd",
  "tee",
  "xargs",
  "seq",
  "expr",
  "true",
  "false",
  "sleep",
  "timeout",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "od",
  "strings",
  "split",
  "readlink",
  "chmod",
  "which",
  "whoami",
  "hostname",
  "help",
  "bash",
  "sh",
  "time",
] as const;
