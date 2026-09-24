/**
 * Network module
 *
 * Provides secure network access with URL allow-list enforcement.
 */

// the allow-list rules, for 1ctx's credential prefixes (1ctx)
export {
  matchesAllowListEntry,
  validateAllowList,
} from "./allow-list.js";
export {
  createSecureFetch,
  type SecureFetch,
  type SecureFetchOptions,
} from "./fetch.js";

export {
  type AllowedUrl,
  type AllowedUrlEntry,
  type FetchResult,
  type HttpMethod,
  NetworkAccessDeniedError,
  type NetworkConfig,
  RedirectNotAllowedError,
  type RequestTransform,
  TooManyRedirectsError,
} from "./types.js";
