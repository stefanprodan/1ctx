/**
 * (1ctx) How rg reads what it searches, moved out of rg-search.ts:
 * standard input, a file, a gzip file under -z, and --pre's output.
 */

import { gunzipSync } from "node:zlib";
import {
  decodeBytesToUtf8,
  readBytesFrom,
  unsafeBytesFromLatin1,
  utf8ByteLength,
  latin1FromBytes,
} from "../../encoding.js";
import type { ResourceLease } from "../../execution-scope.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import { createUserRegex } from "../../regex/index.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { RgOptions } from "./rg-options.js";

export interface FileData {
  content: string;
  isBinary: boolean;
  lease?: ResourceLease;
}

/**
 * Check if data is gzip compressed (magic bytes)
 */
function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Simple glob matching
 */
function matchGlob(str: string, pattern: string, ignoreCase = false): boolean {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (char === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        let charClass = pattern.slice(i, j + 1);
        if (charClass.startsWith("[!")) {
          charClass = `[^${charClass.slice(2)}`;
        }
        regexStr += charClass;
        i = j;
      } else {
        regexStr += "\\[";
      }
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";

  return createUserRegex(regexStr, ignoreCase ? "i" : "").test(str);
}

/**
 * Check if a file matches any pre-glob patterns
 */
function matchesPreGlob(filename: string, preGlobs: string[]): boolean {
  if (preGlobs.length === 0) return true; // No patterns = match all

  for (const glob of preGlobs) {
    if (matchGlob(filename, glob, false)) {
      return true;
    }
  }
  return false;
}

/**
 * Read file content, handling preprocessing and gzip decompression if needed
 */
/** (1ctx) Standard input, searched as a file named `<stdin>`. */
export function readStdin(ctx: RuntimeCommandContext): {
  content: string;
  isBinary: boolean;
  lease?: ResourceLease;
} {
  const content = decodeBytesToUtf8(ctx.stdin);
  return { content, isBinary: content.slice(0, 8192).includes("\0") };
}

export async function readFileContent(
  ctx: RuntimeCommandContext,
  filePath: string,
  file: string,
  options: RgOptions,
): Promise<{
  content: string;
  isBinary: boolean;
  lease?: ResourceLease;
} | null> {
  let lease: ResourceLease | undefined;
  try {
    // Check for preprocessing with --pre
    if (options.preprocessor && ctx.exec) {
      const filename = file.split("/").pop() || file;
      if (matchesPreGlob(filename, options.preprocessorGlobs)) {
        // Run preprocessor on this file
        const result = await ctx.exec(shellJoinArgs([options.preprocessor]), {
          cwd: ctx.cwd,
          signal: ctx.signal,
          args: [filePath],
        });
        if (result.exitCode === 0 && result.stdout) {
          // Preprocessor output arrives as a latin1 byte buffer in the
          // pipeline; decode for regex matching. Empty output falls through.
          lease = ctx.executionScope?.reserveBytes(
            "rg preprocessor text",
            result.stdout.length,
            "rg preprocessor",
          );
          const content = decodeBytesToUtf8(
            unsafeBytesFromLatin1(result.stdout),
          );
          ctx.executionScope?.consumeInput(
            utf8ByteLength(content),
            "rg preprocessor",
          );
          const sample = content.slice(0, 8192);
          return { content, isBinary: sample.includes("\0"), lease };
        }
        // Preprocessing failed, fall through to normal file read
      }
    }

    // For -z option, try to decompress gzip files
    if (options.searchZip && file.endsWith(".gz")) {
      const stat = await ctx.fs.stat(filePath);
      const inputLease = ctx.executionScope?.reserveBytes(
        "rg compressed input",
        stat.size,
        "rg",
      );
      const buffer = await ctx.fs.readFileBuffer(filePath);
      if (buffer.byteLength > stat.size) {
        inputLease?.release();
        throw new ExecutionLimitError(
          "rg: file grew while being read",
          "string_length",
        );
      }
      ctx.executionScope?.consumeInput(buffer.byteLength, "rg");
      if (isGzip(buffer)) {
        let outputLease: ResourceLease | undefined;
        try {
          // The decoded string can coexist with zlib's output buffer. Reserve
          // both before invoking the whole-buffer codec.
          const outputCapacity = Math.min(
            ctx.limits.maxStringLength,
            ctx.limits.maxOutputSize,
            Math.floor(
              (ctx.executionScope?.remainingLiveBytes ??
                ctx.limits.maxLiveBytes) / 2,
            ),
          );
          outputLease = ctx.executionScope?.reserveBytes(
            "rg decompressed text",
            outputCapacity * 2,
            "rg",
          );
          // @banned-pattern-ignore: zlib maxOutputLength is derived from resolved execution byte limits
          const decompressed = gunzipSync(buffer, {
            maxOutputLength: outputCapacity,
          });
          const content = new TextDecoder().decode(decompressed);
          const sample = content.slice(0, 8192);
          return {
            content,
            isBinary: sample.includes("\0"),
            lease: compositeLease(inputLease, outputLease),
          };
        } catch (error) {
          outputLease?.release();
          inputLease?.release();
          rethrowFatalExecutionError(error);
          return null; // Decompression failed
        }
      }
      inputLease?.release();
    }

    // Regular file read
    const stat = await ctx.fs.stat(filePath);
    // A filesystem read can transiently retain its byte buffer while creating
    // the decoded string, so account for both representations prospectively.
    lease = ctx.executionScope?.reserveBytes(
      "rg file text",
      stat.size * 2,
      "rg",
    );
    const rawContent = await readBytesFrom(ctx.fs, filePath);
    const contentBytes = latin1FromBytes(rawContent).length;
    if (contentBytes > stat.size) {
      throw new ExecutionLimitError(
        "rg: file grew while being read",
        "string_length",
      );
    }
    ctx.executionScope?.consumeInput(contentBytes, "rg");
    const content = decodeBytesToUtf8(rawContent, ctx.limits.maxStringLength);
    const sample = content.slice(0, 8192);
    return { content, isBinary: sample.includes("\0"), lease };
  } catch (error) {
    lease?.release();
    rethrowFatalExecutionError(error);
    return null;
  }
}

function compositeLease(
  ...leases: Array<ResourceLease | undefined>
): ResourceLease | undefined {
  const active = leases.filter(
    (item): item is ResourceLease => item !== undefined,
  );
  if (active.length === 0) return undefined;
  return {
    release: () => {
      for (const item of active) item.release();
    },
  };
}
