// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An error with a status is what the router turns into a JSON body; any
// other throw is a bug and propagates.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class Unauthorized extends HttpError {
  constructor(message = "sign in") {
    super(401, message);
  }
}

export class Forbidden extends HttpError {
  constructor(message = "forbidden") {
    super(403, message);
  }
}

export class NotFound extends HttpError {
  constructor(message = "not found") {
    super(404, message);
  }
}

export class TooManyRequests extends HttpError {
  constructor(message = "too many requests") {
    super(429, message);
  }
}

export class PayloadTooLarge extends HttpError {
  constructor(message = "body too large") {
    super(413, message);
  }
}

export class Conflict extends HttpError {
  constructor(message = "conflict") {
    super(409, message);
  }
}

// the upstream this request needed did not answer
export class BadGateway extends HttpError {
  constructor(message = "upstream did not answer") {
    super(502, message);
  }
}
