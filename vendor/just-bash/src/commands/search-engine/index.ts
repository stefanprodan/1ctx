/**
 * Shared search engine for grep and rg commands
 *
 * Provides core text searching functionality:
 * - Line-by-line content matching
 * - Context lines (before/after)
 * - Regex building for different modes (basic, extended, fixed, perl)
 */

export {
  edgesOk,
  isWholeWord,
  type LineKind,
  type SearchOptions,
  type SearchResult,
  searchContent,
  type WordEdges,
} from "./matcher.js";
export {
  buildPatterns,
  buildRegex,
  convertReplacement,
  type RegexMode,
  type RegexOptions,
  type RegexResult,
} from "./regex.js";
